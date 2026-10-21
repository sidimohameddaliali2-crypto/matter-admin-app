import express from 'express';
import Customer from '../models/Customer.js';
import Delivery from '../models/Delivery.js';
import Partner from '../models/Partner.js';
import DeliveryChange from '../models/DeliveryChange.js';
import DeliveryIssue from '../models/DeliveryIssue.js';
import BagNote from '../models/BagNote.js';
import Bag from '../models/Bag.js';
import Communication from '../models/Communication.js';
import FlaggedAlert from '../models/FlaggedAlert.js';
import SlackLog from '../models/SlackLog.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import { resolveCustomerMatch, resolveCustomerMatchBulk } from '../services/customerMatchService.js';
import { classifyUploadRow } from '../services/customerUploadIdentity.js';
import { nextCustomerId, isEmailDerivedCustomerId } from '../services/customerIdSequence.js';
import { relinkSubscription, LinkTargetNotFoundError } from '../services/subscriptionLink.js';
import { parsePinInput, isPlausibleCoordinate } from '../services/geocoding.js';
import { protect } from '../middleware/auth.js';
import { effectivePermissions } from '../models/User.js';

const router = express.Router();

// Owner (2026-10-15): customer data and writes must never be public.
router.use(protect);
router.use(async (req, res, next) => {
  const permissions = effectivePermissions(req.user);
  const hasAny = (keys) => keys.some((key) => permissions[key]);
  const readKeys = ['customers', 'website_subscriptions', 'subscription', 'renewal', 'reports', 'delivery_changes', 'complaints'];
  let allowed;
  if (req.method === 'GET' || req.method === 'HEAD') {
    allowed = hasAny(readKeys) || (req.user.role !== 'driver' && permissions.deliveries);
    // Drivers can retrieve a saved pin only for customers on their own deliveries.
    if (!allowed && req.user.role === 'driver' && /^\/[^/]+\/location\/?$/.test(req.path)) {
      try {
        allowed = !!await Delivery.exists({
          customerId: decodeURIComponent(req.path.split('/')[1]),
          driver: req.user._id,
        });
      } catch (error) {
        return res.status(403).json({ success: false, message: 'Customer access denied' });
      }
    }
  } else if (['/match/link', '/match/unlink', '/match/bulk'].includes(req.path.replace(/\/$/, ''))) {
    allowed = hasAny(['customers', 'website_subscriptions']);
  } else if (req.path.replace(/\/$/, '') === '/send-whatsapp-reminder') {
    allowed = hasAny(['customers', 'renewal']);
  } else {
    allowed = permissions.customers;
  }
  if (!allowed) return res.status(403).json({ success: false, message: 'Customer access denied' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const buildEmailRegex = (email) => {
  const cleaned = String(email || '').trim();
  return new RegExp(`^${escapeRegex(cleaned)}$`, 'i');
};

const normalizeMealExclusions = (exclusions) => {
  const raw = String(exclusions || '').trim();
  if (!raw) return '';

  const lowered = raw.toLowerCase();
  if (['none', 'n/a', 'na', '-', 'null'].includes(lowered)) {
    return '';
  }

  const ingredients = raw
    .split(/[\s,;|]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(ingredients)].join(', ');
};

/**
 * Upload customers from email list (Excel/CSV)
 * POST /api/customers/upload-emails
 */
router.post('/upload-emails', async (req, res) => {
  try {
    const { customers, emails } = req.body;

    // Support both new format (with name and id) and old format (emails only)
    let customersToProcess = [];
    
    if (customers && Array.isArray(customers)) {
      customersToProcess = customers;
    } else if (emails && Array.isArray(emails)) {
      // Legacy format - emails only
      customersToProcess = emails.map((email, index) => ({
        customerId: email.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        idGenerated: true, // no real ID was supplied — match by email only
        name: email.split('@')[0],
        email: email
      }));
    } else {
      return res.status(400).json({
        success: false,
        message: 'Please provide customer data (customers array with customerId, name, email)'
      });
    }

    if (customersToProcess.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No customers provided'
      });
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];
    const conflicts = [];

    // Process each customer
    for (const customerData of customersToProcess) {
      try {
        const { customerId, name, email } = customerData;

        // Validate required fields
        if (!customerId || !name || !email) {
          errors.push(`Missing fields for customer: ${JSON.stringify(customerData)}`);
          continue;
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          errors.push(`Invalid email format: ${email}`);
          continue;
        }

        // An upload never changes an existing customer's customerId (issue #4:
        // that orphaned their deliveries and every other record keyed on it).
        // Mismatches are reported for review; renames go through rename-id.
        const [byEmail, byId] = await Promise.all([
          Customer.findOne({ email: buildEmailRegex(email) }),
          Customer.findOne({ customerId: customerId.trim() })
        ]);
        const decision = classifyUploadRow(
          { customerId: customerId.trim(), idGenerated: customerData.idGenerated === true || isEmailDerivedCustomerId(customerId, email) },
          { byEmail, byId }
        );

        if (decision.action === 'conflict') {
          conflicts.push({ customerId: customerId.trim(), email, name, reason: decision.reason, existingCustomerId: decision.existingCustomerId, otherCustomerId: decision.otherCustomerId });
          continue;
        }

        const existingCustomer = decision.action === 'update' ? decision.customer : null;
        if (existingCustomer) {
          // Update existing customer with new data (customerId is left as-is)
          existingCustomer.email = email;
          existingCustomer.firstName = name.trim().split(' ')[0] || 'Unknown';
          existingCustomer.lastName = name.trim().split(' ').slice(1).join(' ') || '';
          existingCustomer.dataSource = 'ImportedFromExcel';
          
          await existingCustomer.save();
          updated++;
          continue;
        }

        // Create new customer
        const newCustomer = new Customer({
          customerId: customerData.idGenerated === true || isEmailDerivedCustomerId(customerId, email) ? await nextCustomerId() : customerId.trim(),
          email: email,
          firstName: name.trim().split(' ')[0] || 'Unknown',
          lastName: name.trim().split(' ').slice(1).join(' ') || '',
          dataSource: 'ImportedFromExcel'
        });

        await newCustomer.save();
        imported++;
      } catch (error) {
        console.error(`Error processing customer:`, error.message);
        if (error.code === 11000) {
          // Duplicate key error - already handled above but shouldn't reach here
          skipped++;
        } else {
          errors.push(`Error processing customer: ${error.message}`);
        }
      }
    }

    res.json({
      success: true,
      message: `Successfully processed ${customersToProcess.length} customers`,
      imported,
      updated,
      skipped,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      errors: errors.length > 0 ? errors : undefined,
      totalProcessed: imported + updated
    });
  } catch (error) {
    console.error('Error uploading customers:', error);
    res.status(500).json({
      success: false,
      message: 'Error uploading customers',
      error: error.message
    });
  }
});

/**
 * Bulk upload customers with detailed information
 * POST /api/customers/upload-bulk
 */
router.post('/upload-bulk', async (req, res) => {
  try {
    const { customers } = req.body;

    if (!customers || !Array.isArray(customers)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide customer data as an array'
      });
    }

    if (customers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No customers provided'
      });
    }

    const errors = [];
    const parsed = []; // validated rows, matched against existing customers below
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    for (const customerData of customers) {
      const {
        customerId, name, mealPlan, starterDate, macroC, macroP, macroF, exclusions,
        noOfMeals, breakfast, phone, email,
        cycleDuration, amountPaid, discount, snackCount
      } = customerData;

      if (!customerId || !name || !email) {
        errors.push(`Missing required fields (ID/Name/Email): ${customerId || '?'}`);
        continue;
      }
      if (!emailRegex.test(email)) {
        errors.push(`Invalid email: ${email}`);
        continue;
      }

      let planStart = null;
      if (starterDate) {
        // MM/DD/YYYY or MM-DD-YYYY (as used in Excel exports)
        const mmddyyyy = String(starterDate).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (mmddyyyy) {
          planStart = new Date(Number(mmddyyyy[3]), Number(mmddyyyy[1]) - 1, Number(mmddyyyy[2]));
        } else {
          planStart = new Date(starterDate);
        }
      }
      const parsedBreakfast = breakfast === true || breakfast === 'true' || breakfast === '1' || String(breakfast).toLowerCase() === 'yes';

      const doc = {
        customerId: customerId.trim(),
        email: email.trim().toLowerCase(),
        firstName: name.trim().split(' ')[0] || 'Unknown',
        lastName: name.trim().split(' ').slice(1).join(' ') || '',
        mealPlan: mealPlan || 'Standard',
        mealExclusion: normalizeMealExclusions(exclusions),
        mealPerDay: parseInt(noOfMeals) || 1,
        breakfastInclude: parsedBreakfast,
        snackCount: parseInt(snackCount) || 0,
        phone: phone || '',
        macros: { C: Number(macroC) || 0, P: Number(macroP) || 0, F: Number(macroF) || 0 },
        planStartDate: planStart && !isNaN(planStart) ? planStart : null,
        cycleDuration: parseInt(cycleDuration) || 0,
        amountPaid: amountPaid || '',
        discount: discount || '',
        dataSource: 'ImportedFromExcel',
        updatedAt: new Date()
      };

      parsed.push(doc);
    }

    // Match every row to an existing customer BEFORE writing anything (issue
    // #4). The old single upsert filtered on "customerId OR email" and then
    // $set the file's customerId, silently renaming the matched customer and
    // orphaning its deliveries. An upload never changes an existing
    // customer's customerId: a row whose ID disagrees with the one on file is
    // reported in `conflicts` and skipped; intended renames use rename-id.
    const byIdMap = new Map();
    const byEmailMap = new Map();
    if (parsed.length > 0) {
      const [idMatches, emailMatches] = await Promise.all([
        Customer.find({ customerId: { $in: [...new Set(parsed.map((d) => d.customerId))] } }).select('_id customerId email').lean(),
        Customer.find({ email: { $in: [...new Set(parsed.map((d) => d.email))] } })
          .collation({ locale: 'en', strength: 2 }) // emails match case-insensitively
          .select('_id customerId email').lean()
      ]);
      idMatches.forEach((c) => byIdMap.set(c.customerId, c));
      emailMatches.forEach((c) => byEmailMap.set(String(c.email).toLowerCase(), c));
    }

    const ops = [];
    const conflicts = [];
    for (const doc of parsed) {
      const decision = classifyUploadRow(
        { customerId: doc.customerId, idGenerated: isEmailDerivedCustomerId(doc.customerId, doc.email) },
        { byEmail: byEmailMap.get(doc.email) || null, byId: byIdMap.get(doc.customerId) || null }
      );

      if (decision.action === 'conflict') {
        conflicts.push({
          customerId: doc.customerId,
          email: doc.email,
          name: `${doc.firstName} ${doc.lastName}`.trim(),
          reason: decision.reason,
          existingCustomerId: decision.existingCustomerId,
          otherCustomerId: decision.otherCustomerId
        });
        continue;
      }

      if (decision.action === 'update') {
        // Matched by the customer's own (unchanged) customerId; the file's ID is not written.
        const { customerId: _keepExistingId, ...fields } = doc;
        ops.push({ updateOne: { filter: { customerId: decision.customer.customerId }, update: { $set: fields } } });
      } else {
        if (isEmailDerivedCustomerId(doc.customerId, doc.email)) doc.customerId = await nextCustomerId();
        ops.push({
          updateOne: {
            filter: { customerId: doc.customerId },
            update: { $set: doc, $setOnInsert: { createdAt: new Date() } },
            upsert: true
          }
        });
        // Later duplicate rows in the same file now resolve to this new customer.
        const placeholder = { _id: `new:${doc.customerId}`, customerId: doc.customerId, email: doc.email };
        byIdMap.set(doc.customerId, placeholder);
        byEmailMap.set(doc.email, placeholder);
      }
    }

    let created = 0;
    let updated = 0;

    if (ops.length > 0) {
      const result = await Customer.bulkWrite(ops, { ordered: false });
      created = result.upsertedCount || 0;
      updated = (result.modifiedCount || 0) + (result.matchedCount || 0) - created;
    }

    res.json({
      success: true,
      message: `Successfully processed ${ops.length} customers`,
      created,
      updated,
      skipped: conflicts.length,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      errors: errors.length > 0 ? errors : undefined,
      totalProcessed: created + updated
    });
  } catch (error) {
    console.error('Error uploading customers:', error);
    res.status(500).json({
      success: false,
      message: 'Error uploading customers',
      error: error.message
    });
  }
});

/**
 * Bulk upload macros for customers
 * POST /api/customers/upload-macros
 */
router.post('/upload-macros', async (req, res) => {
  try {
    const { records } = req.body;

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide macro records as an array'
      });
    }

    if (records.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No macro records provided'
      });
    }

    const errors = [];
    const operations = [];
    const seenIds = new Set();

    for (const record of records) {
      const { customerId, customerName, C, P, F } = record;
      if (!customerId || C === undefined || P === undefined || F === undefined) {
        errors.push(`Missing required fields for macro record: ${JSON.stringify(record)}`);
        continue;
      }

      const normalizedCustomerId = String(customerId).trim();
      if (!normalizedCustomerId) {
        errors.push(`Row missing valid customerId: ${JSON.stringify(record)}`);
        continue;
      }

      if (seenIds.has(normalizedCustomerId)) {
        errors.push(`Duplicate customerId found: ${normalizedCustomerId}`);
        continue;
      }
      seenIds.add(normalizedCustomerId);

      const macroC = Number(C);
      const macroP = Number(P);
      const macroF = Number(F);

      if (Number.isNaN(macroC) || Number.isNaN(macroP) || Number.isNaN(macroF)) {
        errors.push(`Invalid macro numbers for record: ${JSON.stringify(record)}`);
        continue;
      }

      const nameParts = (String(customerName || '').trim() || '').split(' ').filter(Boolean);
      const firstName = nameParts[0] || 'Unknown';
      const lastName = nameParts.slice(1).join(' ');

      operations.push({
        updateOne: {
          filter: { customerId: normalizedCustomerId },
          update: {
            $set: {
              customerId: normalizedCustomerId,
              firstName,
              lastName,
              macros: { C: macroC, P: macroP, F: macroF },
              dataSource: 'ImportedFromExcel'
            }
          },
          upsert: true
        }
      });
    }

    if (operations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid macro records to process',
        errors
      });
    }

    const bulkResult = await Customer.bulkWrite(operations, { ordered: false });
    const created = bulkResult.upsertedCount || 0;
    const updated = bulkResult.modifiedCount || bulkResult.nModified || 0;

    res.json({
      success: true,
      message: `Processed ${operations.length} macro records`,
      created,
      updated,
      errors: errors.length > 0 ? errors : undefined,
      totalProcessed: operations.length
    });
  } catch (error) {
    console.error('Error uploading macro records:', error);
    res.status(500).json({
      success: false,
      message: 'Error uploading macro records',
      error: error.message
    });
  }
});

/**
 * Create a new customer
 * POST /api/customers
 */
router.post('/', async (req, res) => {
  try {
    const { customerId, firstName, lastName, email, phone, company } = req.body;

    // Validate required fields
    if (!firstName || !email) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: firstName and email are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    // Check if customer already exists
    const existingCustomer = await Customer.findOne({
      $or: [
        { email: buildEmailRegex(email) },
        ...(customerId ? [{ customerId: customerId.trim() }] : [])
      ]
    });

    if (existingCustomer) {
      return res.status(409).json({
        success: false,
        message: existingCustomer.email.toLowerCase() === email.toLowerCase()
          ? `Customer with email ${email} already exists`
          : `Customer with ID ${customerId} already exists`
      });
    }

    // Create new customer
    const newCustomer = new Customer({
      customerId: !customerId || customerId === 'CUST-' || isEmailDerivedCustomerId(customerId, email) ? await nextCustomerId() : customerId.trim(),
      firstName: firstName.trim(),
      lastName: lastName?.trim() || '',
      email: email.trim(),
      phone: phone?.trim() || '',
      company: company?.trim() || '',
      dataSource: 'ManualEntry'
    });

    await newCustomer.save();

    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: newCustomer
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating customer',
      error: error.message
    });
  }
});

/**
 * Get all customers
 * GET /api/customers
 */
router.get('/', async (req, res) => {
  try {
    const { search, limit } = req.query;
    const query = {};

    if (search && search.trim().length > 0) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [
        { customerId: regex },
        { firstName: regex },
        { lastName: regex },
        { email: regex }
      ];
    }

    const maxLimit = Math.min(parseInt(limit, 10) || 10000, 10000);

    const customers = await Customer.find(query)
      .select('customerId email cpf macros firstName lastName phone company address gpsLocation planStartDate cycleDuration amountPaid discount')
      .sort({ createdAt: -1 })
      .limit(maxLimit);

    res.json({
      success: true,
      data: customers,
      count: customers.length
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching customers',
      error: error.message
    });
  }
});

/**
 * Send WhatsApp renewal reminder via Gallabox
 * POST /api/customers/send-whatsapp-reminder
 */
router.post('/send-whatsapp-reminder', async (req, res) => {
  try {
    const { customerId, customerName, mealPlan, lastDeliveryDate, remaining, discount, phone } = req.body;

    // Always send to the default recipient; falls back to customer phone if not set
    const recipientPhone = (process.env.GALLABOX_DEFAULT_PHONE || phone || '').replace(/\s+/g, '');

    if (!recipientPhone) {
      return res.status(400).json({ success: false, message: 'No recipient phone number available' });
    }

    // Use the same date already shown to the user in the Renewal table (actual last
    // delivery, or projected last day for active plans) rather than recomputing it
    let endDate = 'N/A';
    if (lastDeliveryDate) {
      const date = new Date(lastDeliveryDate);
      if (!Number.isNaN(date.getTime())) {
        endDate = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      }
    }

    // Gallabox expects phone without leading +
    const formattedPhone = recipientPhone.startsWith('+') ? recipientPhone.slice(1) : recipientPhone;

    const payload = {
      channelId: process.env.GALLABOX_CHANNEL_ID,
      channelType: 'whatsapp',
      recipient: {
        name: customerName || 'Customer',
        phone: formattedPhone,
      },
      whatsapp: {
        type: 'template',
        template: {
          templateName: 'renewal_reminder2_clone',
          bodyValues: {
            name: customerName || 'Customer',
            variable_2: mealPlan || 'Standard',
            variable_3: endDate,
            variable_4: String(remaining ?? 0),
            variable_5: discount || '0',
            variable_6: 'CIRCLE',
          },
          buttonValues: [
            { index: 0, sub_type: 'quick_reply', parameters: { type: 'payload', payload: 'www.matternutrition.xyz' } },
            { index: 1, sub_type: 'quick_reply', parameters: { type: 'payload', payload: 'No Renewal' } },
          ],
        },
      },
    };

    console.log('Gallabox payload:', JSON.stringify(payload, null, 2));

    const response = await fetch('https://server.gallabox.com/devapi/messages/whatsapp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apiKey: process.env.GALLABOX_API_KEY,
        apiSecret: process.env.GALLABOX_API_SECRET,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log('Gallabox response:', response.status, JSON.stringify(data));

    if (!response.ok) {
      return res.status(response.status).json({ success: false, message: data?.message || 'Gallabox API error', details: data });
    }

    console.log(`WhatsApp reminder sent to ${customerName} (${recipientPhone})`);
    res.json({ success: true, message: 'Reminder sent', data });
  } catch (error) {
    console.error('Error sending WhatsApp reminder:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Update customer fields
 * PATCH /api/customers/:customerId
 */
router.patch('/:customerId', async (req, res) => {
  try {
    const allowed = [
      'planStartDate', 'cycleDuration', 'amountPaid', 'discount',
      // Identity / contact details editable from the customer detail page
      'firstName', 'lastName', 'phone', 'company', 'address', 'email',
      // Links this customer to a B2B Partner whose members order via the
      // regular Menu Selection flow — see Partner.menuSelectionEnabled.
      'partner', 'unlimitedMeals', 'macros',
    ];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    // Never write an empty-string email: it would collide on the unique sparse
    // index with every other customer that has no email.
    if (updates.email === '' || updates.email === null) delete updates.email;

    // Unlinking clears the partner ref cleanly (empty string from a <select>
    // means "no partner"); linking to a menu-selection partner auto-applies
    // its preset macros and lifts the daily meal cap unless the caller sent
    // an explicit override in the same request.
    if (updates.partner === '' || updates.partner === null) {
      updates.partner = null;
    } else if (updates.partner) {
      const linkedPartner = await Partner.findById(updates.partner).select('menuSelectionEnabled presetMacros');
      if (!linkedPartner) {
        return res.status(400).json({ success: false, message: 'Partner not found' });
      }
      if (linkedPartner.menuSelectionEnabled) {
        if (req.body.unlimitedMeals === undefined) updates.unlimitedMeals = true;
        if (req.body.macros === undefined) updates.macros = linkedPartner.presetMacros;
      }
    }

    // The customer's saved map pin (internal record). Entered as a Google Maps
    // link or "lat, lng"; an empty value clears it. It is tied to the address
    // text it was saved with, because deliveries only reuse a customer pin when
    // their address matches exactly (see resolveDeliveryCoordinatesCached).
    if (req.body.mapsLink !== undefined) {
      const raw = String(req.body.mapsLink ?? '').trim();
      if (!raw) {
        updates.gpsLocation = { lat: null, lng: null, source: null, address: null, geocodedAt: null };
      } else {
        const pin = parsePinInput(raw);
        if (!pin || !isPlausibleCoordinate(pin.lat, pin.lng)) {
          return res.status(400).json({
            success: false,
            message: 'Could not read a location from that. Paste a full Google Maps link that contains the coordinates (open the short link first) or type "lat, lng", e.g. 25.2048, 55.2708.'
          });
        }
        let pinAddress = typeof updates.address === 'string' ? updates.address.trim() : null;
        if (pinAddress === null) {
          const existing = await Customer.findOne({ customerId: req.params.customerId }).select('address').lean();
          pinAddress = String(existing?.address || '').trim();
        }
        updates.gpsLocation = { lat: pin.lat, lng: pin.lng, source: 'manual', address: pinAddress, geocodedAt: new Date() };
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    // upsert so a customer that only exists on delivery records (no Customer
    // document yet) can still be edited — the edit creates the record.
    const customer = await Customer.findOneAndUpdate(
      { customerId: req.params.customerId },
      { $set: updates, $setOnInsert: { customerId: req.params.customerId } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, data: customer });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'That email is already used by another customer' });
    }
    console.error('Error updating customer:', error);
    res.status(500).json({ success: false, message: 'Error updating customer' });
  }
});

/**
 * Rename a customer's customerId — a distinct operation from the regular
 * field PATCH above, because customerId is stored as a plain string (not an
 * ObjectId ref) on 9 other collections: Delivery, DeliveryChange,
 * DeliveryIssue, BagNote, Bag (assignedTo.customer.customerId),
 * Communication, FlaggedAlert, SlackLog, MenuSelectionRecord. Renaming it
 * without also updating every one of those would orphan them — the exact
 * "duplicate/Unknown customer" bug class fixed via mergeUnnamedCustomerInto-
 * RealRecord.js (2026-09-29) — so this cascades the new value everywhere
 * that string is stored, not just on the Customer document itself.
 *
 * Identified by the CURRENT customerId (:oldCustomerId), matching every
 * other route on this page — the client's customer objects never carry the
 * Mongo _id. A retry after a crash mid-cascade would 404 here since the
 * Customer document is already renamed by then; that's an accepted rare
 * edge case, surfaced as a normal 404 rather than silently no-op'd.
 *
 * PATCH /api/customers/:oldCustomerId/rename-id
 * Body: { newCustomerId }
 */
router.patch('/:oldCustomerId/rename-id', async (req, res) => {
  try {
    const newCustomerId = String(req.body.newCustomerId || '').trim();
    if (!newCustomerId) {
      return res.status(400).json({ success: false, message: 'newCustomerId is required' });
    }

    const customer = await Customer.findOne({ customerId: req.params.oldCustomerId });
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const oldCustomerId = customer.customerId;
    if (newCustomerId === oldCustomerId) {
      return res.json({ success: true, data: customer, cascaded: null });
    }

    const clash = await Customer.findOne({ customerId: newCustomerId, _id: { $ne: customer._id } }).select('_id');
    if (clash) {
      return res.status(409).json({ success: false, message: `Customer ID "${newCustomerId}" is already in use` });
    }

    // Rename the canonical record first — cheap, single-document, and once
    // this succeeds the new ID is the source of truth even if a cascade
    // step below fails partway (each updateMany below is independently
    // re-runnable: matching on the still-old value in each collection, a
    // retry of this same request after a partial failure just picks up
    // wherever it left off, since already-migrated collections have nothing
    // left matching oldCustomerId).
    customer.customerId = newCustomerId;
    await customer.save();

    const cascadeTargets = [
      ['deliveries', Delivery, 'customerId'],
      ['deliveryChanges', DeliveryChange, 'customerId'],
      ['deliveryIssues', DeliveryIssue, 'customerId'],
      ['bagNotes', BagNote, 'customerId'],
      ['bagsCurrentAssignment', Bag, 'assignedTo.customer.customerId'],
      ['communications', Communication, 'customerId'],
      ['flaggedAlerts', FlaggedAlert, 'customerId'],
      ['slackLogs', SlackLog, 'customerId'],
      ['menuSelectionRecords', MenuSelectionRecord, 'customerId']
    ];

    const cascaded = {};
    const failures = [];
    for (const [label, Model, field] of cascadeTargets) {
      try {
        const result = await Model.updateMany({ [field]: oldCustomerId }, { $set: { [field]: newCustomerId } });
        cascaded[label] = result.modifiedCount || 0;
      } catch (cascadeError) {
        failures.push(label);
        cascaded[label] = `failed: ${cascadeError.message}`;
      }
    }

    // Audit trail for the one sanctioned way to change a customerId (#4): who,
    // before/after, and what was updated where.
    console.info('[customer-id-rename]', JSON.stringify({
      from: oldCustomerId,
      to: newCustomerId,
      by: req.user?._id ? String(req.user._id) : null,
      cascaded,
      partialFailure: failures.length > 0 ? failures : null
    }));

    res.json({
      success: true,
      data: customer,
      cascaded,
      // Surfaced so the client can warn the user even though the rename
      // itself succeeded — a failure here means some historical records
      // still show the old ID until this endpoint is retried.
      partialFailure: failures.length > 0 ? failures : undefined
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'That Customer ID is already in use' });
    }
    console.error('Error renaming customer ID:', error);
    res.status(500).json({ success: false, message: 'Error renaming customer ID' });
  }
});

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
const phoneSuffix = (value, len = 9) => normalizePhoneDigits(value).slice(-len);

/**
 * Match a customer against an external record (e.g. a Matter website
 * subscription) by cascading through: a saved manual link -> email -> phone
 * -> name, in that order of confidence. Stops at the first level that finds
 * a match. A manual link (see POST /match/link below) always wins over the
 * automatic email/phone/name guess, since a human already confirmed it.
 * Delegates to customerMatchService so this stays in lockstep with the bulk
 * version below and with the Kitchen auto-populate job.
 * GET /api/customers/match?email=&phone=&name=&subscriptionId=
 */
router.get('/match', async (req, res) => {
  try {
    const { email, phone, name, subscriptionId } = req.query;
    const { customer, matchedBy } = await resolveCustomerMatch({ email, phone, name, subscriptionId });
    res.json({ success: true, data: { customer, matchedBy } });
  } catch (error) {
    console.error('Error matching customer:', error);
    res.status(500).json({ success: false, message: 'Error matching customer', error: error.message });
  }
});

/**
 * Manually link an internal customer to an external (Matter website)
 * subscription id, for when the automatic email/phone/name match in GET
 * /match finds nothing (or finds the wrong record). Saved on the customer as
 * matterSubscriptionId, so it wins over the auto-match on every later load.
 *
 * A subscription can only ever point at one customer: linking it here first
 * clears it off whichever customer (if any) had it before.
 *
 * POST /api/customers/match/link  { customerId, subscriptionId }
 */
router.post('/match/link', async (req, res) => {
  try {
    const { customerId, subscriptionId } = req.body || {};
    if (!customerId || !subscriptionId) {
      return res.status(400).json({ success: false, message: 'customerId and subscriptionId are required' });
    }

    const subId = String(subscriptionId).trim();

    // Verifies the target exists first, then clears the old owner and sets the
    // new one in a single transaction (issue #3) — see services/subscriptionLink.js.
    const customer = await relinkSubscription({ subId, customerId });

    res.json({ success: true, data: { customer, matchedBy: 'manual' } });
  } catch (error) {
    if (error instanceof LinkTargetNotFoundError) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'That subscription is already linked to another customer' });
    }
    console.error('Error linking customer to subscription:', error);
    res.status(500).json({ success: false, message: 'Error linking customer', error: error.message });
  }
});

/**
 * Remove a manual subscription link, e.g. to fix a mistaken match.
 * POST /api/customers/match/unlink  { subscriptionId }
 */
router.post('/match/unlink', async (req, res) => {
  try {
    const { subscriptionId } = req.body || {};
    if (!subscriptionId) {
      return res.status(400).json({ success: false, message: 'subscriptionId is required' });
    }
    await Customer.updateMany(
      { matterSubscriptionId: String(subscriptionId).trim() },
      { $set: { matterSubscriptionId: null } }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error unlinking customer from subscription:', error);
    res.status(500).json({ success: false, message: 'Error unlinking customer', error: error.message });
  }
});

/**
 * Bulk version of GET /match, for the "No internal match" filter on the
 * subscription list — checking hundreds of subscriptions one at a time
 * (each doing its own Customer.find) would be far too slow for a list view.
 * One Customer query, then every subscription is matched against it in
 * memory via the same cascade as GET /match (manual link -> email -> phone
 * -> name), using the shared customerMatchService so the two views can no
 * longer disagree. Phone-level matches only appear here if the caller's
 * subscription payload actually includes a `phone` field — the subscription
 * list endpoint historically didn't send one, so until that's added a
 * phone-only match still won't surface until the subscription is opened via
 * GET /match. That's a caller-side gap, not a matching-logic one.
 *
 * POST /api/customers/match/bulk  { subscriptions: [{ subscriptionId, email, name, phone }] }
 * -> { unmatchedIds: [subscriptionId, ...] }
 */
router.post('/match/bulk', async (req, res) => {
  try {
    const { subscriptions } = req.body || {};
    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      return res.json({ success: true, data: { unmatchedIds: [] } });
    }

    const customers = await Customer.find({})
      .select('email firstName lastName phone matterSubscriptionId')
      .lean();

    const results = resolveCustomerMatchBulk(customers, subscriptions);

    const unmatchedIds = subscriptions
      .filter((s) => s && s.subscriptionId != null)
      .map((s) => String(s.subscriptionId))
      .filter((subId) => !results.get(subId)?.customer);

    res.json({ success: true, data: { unmatchedIds } });
  } catch (error) {
    console.error('Error bulk-matching customers:', error);
    res.status(500).json({ success: false, message: 'Error bulk-matching customers', error: error.message });
  }
});

/**
 * Get customer by email
 * GET /api/customers/email/:email
 */
router.get('/email/:email', async (req, res) => {
  try {
    const customer = await Customer.findOne({ email: buildEmailRegex(req.params.email) });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    res.json({
      success: true,
      data: customer
    });
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching customer',
      error: error.message
    });
  }
});

/**
 * Get location (address, zone, GPS) from a customer's most recent delivery
 * GET /api/customers/:customerId/location
 */
router.get('/:customerId/location', async (req, res) => {
  try {
    const query = { customerId: req.params.customerId, address: { $exists: true, $ne: '' } };
    if (req.user.role === 'driver') query.driver = req.user._id;
    const delivery = await Delivery.findOne(
      query,
      { address: 1, zone: 1, gpsLocation: 1 }
    ).sort({ scheduledTime: -1 }).lean();

    if (!delivery) {
      return res.json({ success: true, data: null });
    }

    res.json({
      success: true,
      data: {
        address: delivery.address || '',
        zone: delivery.zone || '',
        gpsLocation: delivery.gpsLocation || null
      }
    });
  } catch (error) {
    console.error('Error fetching customer location:', error);
    res.status(500).json({ success: false, message: 'Error fetching customer location' });
  }
});

export default router;
