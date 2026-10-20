import express from 'express';
import { protect as auth } from '../middleware/auth.js';
import Event from '../models/Event.js';
import EventOptions from '../models/EventOptions.js';
import User from '../models/User.js';
import YellowblockAsset from '../models/YellowblockAsset.js';
import YellowblockAssetUsage from '../models/YellowblockAssetUsage.js';
import { notifyEventCreated, notifyEventStatusChange } from '../services/slackEventService.js';

const router = express.Router();

const parseDateInput = (value) => {
  if (!value) return null;
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
};

const normalizeAssetsUsedInput = (assetsUsed) => {
  if (!Array.isArray(assetsUsed)) return [];

  return assetsUsed
    .map((asset) => ({
      assetId: asset?.assetId,
      quantityUsed: Number(asset?.quantityUsed || 0),
    }))
    .filter((asset) => asset.assetId && asset.quantityUsed > 0);
};

const enrichAssetsUsedForStorage = (assetsUsed = []) => {
  if (!Array.isArray(assetsUsed)) return [];
  return assetsUsed.map((asset) => ({
    assetId: asset?.assetId,
    itemType: asset?.itemType || '',
    unit: asset?.unit || '',
    material: asset?.material || '',
    unitPrice: Number(asset?.unitPrice || 0),
    quantityUsed: Number(asset?.quantityUsed || 0),
    totalPrice: Number(asset?.unitPrice || 0) * Number(asset?.quantityUsed || 0),
    placeOfStorage: asset?.placeOfStorage || '',
    imageUrl: asset?.imageUrl || '',
  }));
};

const applyAssetUsage = async ({ assetsUsed, event, userId, note }) => {
  const normalized = normalizeAssetsUsedInput(assetsUsed);
  if (!normalized.length) return [];

  const enriched = [];

  for (const row of normalized) {
    const updated = await YellowblockAsset.findOneAndUpdate(
      {
        _id: row.assetId,
        companyName: 'Yellow Block',
        isActive: true,
        totalCountAvailable: { $gte: row.quantityUsed },
      },
      {
        $inc: {
          totalCountAvailable: -row.quantityUsed,
          totalCountUsed: row.quantityUsed,
        },
      },
      { new: true }
    ).lean();

    if (!updated) {
      throw new Error('Insufficient units available for selected asset');
    }

    const usagePayload = {
      assetId: updated._id,
      eventId: event._id,
      eventName: event.eventName,
      quantityUsed: row.quantityUsed,
      usedBy: userId,
      usedAt: new Date(),
      note: note || 'Used during event save',
      unitPriceSnapshot: updated.unitPrice || 0,
      unitSnapshot: updated.unit || '',
      materialSnapshot: updated.material || '',
      placeOfStorageSnapshot: updated.placeOfStorage || '',
    };

    await YellowblockAssetUsage.create(usagePayload);

    await YellowblockAsset.updateOne(
      { _id: updated._id },
      {
        $push: {
          usageLogs: {
            eventId: event._id,
            eventName: event.eventName,
            quantityUsed: row.quantityUsed,
            usedBy: userId,
            usedAt: usagePayload.usedAt,
            note: usagePayload.note,
          },
        },
      }
    );

    enriched.push({
      assetId: updated._id,
      itemType: updated.itemType,
      unit: updated.unit,
      material: updated.material,
      unitPrice: updated.unitPrice,
      quantityUsed: row.quantityUsed,
      totalPrice: (updated.unitPrice || 0) * row.quantityUsed,
      placeOfStorage: updated.placeOfStorage,
      imageUrl: updated.imageUrl,
    });
  }

  return enriched;
};

const restoreAssetUsage = async (assetsUsed = []) => {
  const normalized = normalizeAssetsUsedInput(assetsUsed);
  for (const row of normalized) {
    await YellowblockAsset.updateOne(
      { _id: row.assetId },
      {
        $inc: {
          totalCountAvailable: row.quantityUsed,
          totalCountUsed: -row.quantityUsed,
        },
      }
    );
  }
};

// Default options seeded when a company has no saved options yet
const DEFAULT_OPTIONS = {
  Matter: {
    equipment: [
      { name: 'Tent', dimensions: '', description: 'Event tent' },
      { name: 'Branded Table', dimensions: '', description: 'Branded table' },
      { name: 'Basic Table', dimensions: '180cm × 90cm', description: 'Standard white table' },
      { name: 'Flyers', dimensions: '', description: 'Promotional flyers' },
      { name: 'Cooler Boxes', dimensions: '', description: 'Insulated cooler boxes' },
      { name: 'Flag', dimensions: '', description: 'Branded flag' }
    ],
    food: [
      { name: 'Chicken Wrap', description: '' },
      { name: 'Oats', description: '' },
      { name: 'PB Truffles', description: '' },
      { name: 'Cheesecake Bites', description: '' },
      { name: 'Beef Wrap', description: '' },
      { name: 'Breakfast Wrap', description: '' },
      { name: 'Other (Please specify)', description: '' }
    ]
  }
};

/**
 * GET /api/events/options/:company
 * Get equipment and food options for a company.
 * Seeds from DEFAULT_OPTIONS if company has no saved options.
 */
router.get('/options/:company', auth, async (req, res) => {
  try {
    const company = req.params.company.trim();
    let doc = await EventOptions.findOne({ company });

    if (!doc && DEFAULT_OPTIONS[company]) {
      // Auto-seed defaults into DB on first request
      doc = await EventOptions.create({ company, ...DEFAULT_OPTIONS[company] });
    }

    if (!doc) {
      return res.json({ success: true, data: { company, equipment: [], food: [] } });
    }

    res.json({ success: true, data: doc });
  } catch (error) {
    console.error('Get event options error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/events/options/:company
 * Save equipment and food options for a company.
 */
router.put('/options/:company', auth, async (req, res) => {
  try {
    const company = req.params.company.trim();
    const { equipment, food } = req.body;

    const doc = await EventOptions.findOneAndUpdate(
      { company },
      { $set: { equipment, food } },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({ success: true, data: doc });
  } catch (error) {
    console.error('Save event options error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/events
 * Get all events (optionally filtered by company)
 */
router.get('/', auth, async (req, res) => {
  try {
    const { company, status, emirate, searchTerm } = req.query;
    let filter = {};

    if (company) {
      filter.company = company;
    }

    if (status) {
      filter.status = status;
    }

    if (emirate) {
      filter.emirate = emirate;
    }

    if (searchTerm) {
      filter.$or = [
        { eventName: { $regex: searchTerm, $options: 'i' } },
        { companyName: { $regex: searchTerm, $options: 'i' } },
        { 'venue.address': { $regex: searchTerm, $options: 'i' } }
      ];
    }

    const events = await Event.find(filter)
      .populate('company', 'profile._id profile.firstName profile.lastName profile.picture')
      .populate('assignedDriver', 'profile._id profile.firstName profile.lastName')
      .sort({ eventDate: -1 })
      .lean();

    // Normalize logistics.food to [] for events created before the food field was added
    events.forEach(e => {
      if (e.logistics && !Array.isArray(e.logistics.food)) e.logistics.food = [];
      if (e.logistics && !Array.isArray(e.logistics.assetsUsed)) e.logistics.assetsUsed = [];
      if (e.logistics && typeof e.logistics.assetsCheckedOut !== 'boolean') e.logistics.assetsCheckedOut = false;
    });

    res.json({
      success: true,
      count: events.length,
      events
    });
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/events/:id
 * Get single event by ID
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id)
      .populate('company', 'profile._id profile.firstName profile.lastName profile.picture')
      .populate('assignedDriver', 'profile._id profile.firstName profile.lastName profile.status profile.picture');

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Normalize logistics.food to [] for events created before the food field was added
    const eventObj = event.toObject();
    if (eventObj.logistics && !Array.isArray(eventObj.logistics.food)) eventObj.logistics.food = [];
    if (eventObj.logistics && !Array.isArray(eventObj.logistics.assetsUsed)) eventObj.logistics.assetsUsed = [];
    if (eventObj.logistics && typeof eventObj.logistics.assetsCheckedOut !== 'boolean') eventObj.logistics.assetsCheckedOut = false;

    res.json({
      success: true,
      event: eventObj
    });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/events
 * Create new event
 */
router.post('/', auth, async (req, res) => {
  try {
    const { eventName, companyId, companyName, companyLogo, eventDate, emirate, venue, arrivalTime, pointOfContact, flowerCollection, logistics, disassembly, isPaid, notes, driverProvider } = req.body;

    // predefined logos for known companies
    const logoMap = {
      Matter: '/images/matter-logo24-dark.png',
      'Yellow Block': '/images/yellow-block-logo.png'
    };

    // Validate required fields (companyName will be inferred from company record if not sent)
    if (!eventName || !eventDate || !emirate || !venue || !arrivalTime) {
      return res.status(400).json({
        error: 'Missing required fields: eventName, eventDate, emirate, venue, arrivalTime'
      });
    }

    const normalizedEventDate = parseDateInput(eventDate);
    if (!normalizedEventDate) {
      return res.status(400).json({
        error: 'Invalid eventDate value'
      });
    }

    const normalizedDisassemblyDate = parseDateInput(disassembly?.date);

    // Get company info if provided
    let company = null;
    if (companyId) {
      try {
        company = await User.findById(companyId).lean();
      } catch (err) {
        console.error('Error finding company:', err);
      }
    }

    // if request didn't supply a companyName but we found the company document,
    // use the profile names to keep things consistent.
    const finalCompanyName =
      companyName ||
      (company ? `${company.profile.firstName || ''} ${company.profile.lastName || ''}`.trim() : '');

    const eventData = {
      eventName,
      company: companyId || null,
      companyName: finalCompanyName,
      companyLogo: companyLogo || company?.profile?.picture || logoMap[finalCompanyName] || null,
      eventDate: normalizedEventDate,
      emirate,
      venue: {
        type: venue.type || 'Private Villa',
        address: venue.address || '',
        area: venue.area || '',
        googleMapsLink: venue.googleMapsLink || null,
        latitude: venue.latitude || null,
        longitude: venue.longitude || null
      },
      arrivalTime,
      pointOfContact: {
        noPointOfContact: !!pointOfContact?.noPointOfContact,
        name: pointOfContact?.name || '',
        phone: pointOfContact?.phone || '',
        email: pointOfContact?.email || ''
      },
      flowerCollection: {
        shopLocation: flowerCollection?.shopLocation || '',
        flowerCount: flowerCollection?.flowerCount || 1,
        pictureUrl: flowerCollection?.pictureUrl || ''
      },
      logistics: logistics ? {
        noLogisticsNeeded: !!logistics.noLogisticsNeeded,
        numberOfPeople: logistics.numberOfPeople || 1,
        staffNames: logistics.staffNames || [],
        specialRequests: logistics.specialRequests || '',
        equipment: logistics.equipment || [],
        assetsUsed: logistics.assetsUsed || [],
        assetsCheckedOut: false,
        food: logistics.food || []
      } : {
        noLogisticsNeeded: false,
        numberOfPeople: 1,
        staffNames: [],
        specialRequests: '',
        equipment: [],
        assetsUsed: [],
        assetsCheckedOut: false,
        food: []
      },
      disassembly: disassembly ? {
        isRequired: disassembly.isRequired || false,
        date: normalizedDisassemblyDate,
        arrivalTime: disassembly.arrivalTime || null,
        disassemblyTime: disassembly.disassemblyTime || null,
        notes: disassembly.notes || ''
      } : {
        isRequired: false,
        date: null,
        arrivalTime: null,
        disassemblyTime: null,
        notes: ''
      },
      notes,
      isPaid: !!isPaid,
      driverProvider: finalCompanyName === 'Yellow Block' && driverProvider === 'matter' ? 'matter' : 'yellow_block'
    };

    const event = new Event(eventData);

    if (
      event.companyName === 'Yellow Block' &&
      event.status !== 'completed' &&
      Array.isArray(eventData.logistics?.assetsUsed) &&
      eventData.logistics.assetsUsed.length > 0
    ) {
      const enrichedAssetsUsed = await applyAssetUsage({
        assetsUsed: eventData.logistics.assetsUsed,
        event,
        userId: req.user._id,
        note: 'Asset usage from event creation',
      });
      event.logistics.assetsUsed = enrichedAssetsUsed;
      event.logistics.assetsCheckedOut = true;
    }

    await event.save();

    // Send Slack notification (non-blocking)
    notifyEventCreated(event).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Event created successfully',
      event
    });
  } catch (error) {
    console.error('Create event error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Duplicate event value entered' });
    }

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: Object.values(error.errors).map((value) => value.message).join(', ')
      });
    }

    res.status(500).json({ error: error.message || 'Failed to create event' });
  }
});

/**
 * PATCH /api/events/:id
 * Update event
 */
router.patch('/:id', auth, async (req, res) => {
  try {
    const { eventName, eventDate, emirate, venue, arrivalTime, pointOfContact, flowerCollection, logistics, disassembly, status, notes, assignedDriver, driverProvider } = req.body;

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (event.companyName === 'Yellow Block' && (driverProvider === 'matter' || driverProvider === 'yellow_block')) {
      event.driverProvider = driverProvider;
    }

    // Track old status before any changes (for WhatsApp notification)
    const oldStatus = event.status;
    const previousAssetsUsed = Array.isArray(event.logistics?.assetsUsed) ? event.logistics.assetsUsed : [];
    const wasAssetsCheckedOut = !!event.logistics?.assetsCheckedOut;

    // Update fields
    if (eventName) event.eventName = eventName;
    if (eventDate) event.eventDate = eventDate;
    if (emirate) event.emirate = emirate;
    if (arrivalTime) event.arrivalTime = arrivalTime;
    if (status) event.status = status;
    if (notes) event.notes = notes;

    if (venue) {
      event.venue = {
        type: venue.type || event.venue.type,
        address: venue.address || event.venue.address,
        area: venue.area || event.venue.area,
        googleMapsLink: venue.googleMapsLink || event.venue.googleMapsLink,
        latitude: venue.latitude !== undefined ? venue.latitude : event.venue.latitude,
        longitude: venue.longitude !== undefined ? venue.longitude : event.venue.longitude
      };
    }

    if (pointOfContact) {
      event.pointOfContact = {
        noPointOfContact: pointOfContact.noPointOfContact !== undefined
          ? !!pointOfContact.noPointOfContact
          : !!event.pointOfContact?.noPointOfContact,
        name: pointOfContact.name !== undefined ? pointOfContact.name : (event.pointOfContact?.name || ''),
        phone: pointOfContact.phone !== undefined ? pointOfContact.phone : (event.pointOfContact?.phone || ''),
        email: pointOfContact.email !== undefined ? pointOfContact.email : (event.pointOfContact?.email || '')
      };
    }

    if (flowerCollection) {
      event.flowerCollection = {
        shopLocation: flowerCollection.shopLocation !== undefined ? flowerCollection.shopLocation : (event.flowerCollection?.shopLocation || ''),
        flowerCount: flowerCollection.flowerCount !== undefined ? flowerCollection.flowerCount : (event.flowerCollection?.flowerCount || 1),
        pictureUrl: flowerCollection.pictureUrl !== undefined ? flowerCollection.pictureUrl : (event.flowerCollection?.pictureUrl || '')
      };
    }

    if (logistics) {
      event.logistics = {
        noLogisticsNeeded: logistics.noLogisticsNeeded !== undefined
          ? !!logistics.noLogisticsNeeded
          : !!event.logistics.noLogisticsNeeded,
        numberOfPeople: logistics.numberOfPeople !== undefined ? logistics.numberOfPeople : event.logistics.numberOfPeople,
        staffNames: logistics.staffNames !== undefined ? logistics.staffNames : event.logistics.staffNames,
        specialRequests: logistics.specialRequests !== undefined ? logistics.specialRequests : event.logistics.specialRequests,
        equipment: logistics.equipment !== undefined ? logistics.equipment : event.logistics.equipment,
        assetsUsed: logistics.assetsUsed !== undefined ? logistics.assetsUsed : (event.logistics.assetsUsed || []),
        assetsCheckedOut: logistics.assetsCheckedOut !== undefined ? !!logistics.assetsCheckedOut : !!event.logistics.assetsCheckedOut,
        food: logistics.food !== undefined ? logistics.food : (event.logistics.food || [])
      };
    }

    if (event.companyName === 'Yellow Block' && logistics?.assetsUsed !== undefined) {
      try {
        if (wasAssetsCheckedOut) {
          await restoreAssetUsage(previousAssetsUsed);
        }

        if (event.status !== 'completed') {
          const enrichedAssetsUsed = await applyAssetUsage({
            assetsUsed: logistics.assetsUsed,
            event,
            userId: req.user._id,
            note: 'Asset usage from event update',
          });
          event.logistics.assetsUsed = enrichedAssetsUsed;
          event.logistics.assetsCheckedOut = enrichedAssetsUsed.length > 0;
        } else {
          event.logistics.assetsUsed = enrichAssetsUsedForStorage(logistics.assetsUsed || []);
          event.logistics.assetsCheckedOut = false;
        }
      } catch (assetError) {
        // Best-effort rollback to preserve previous allocation if the new one fails.
        if (wasAssetsCheckedOut) {
          await applyAssetUsage({
            assetsUsed: previousAssetsUsed,
            event,
            userId: req.user._id,
            note: 'Rollback previous asset usage after failed update',
          }).catch(() => {});
        }
        event.logistics.assetsCheckedOut = wasAssetsCheckedOut;
        throw assetError;
      }
    }

    if (disassembly) {
      event.disassembly = {
        isRequired: disassembly.isRequired !== undefined ? disassembly.isRequired : event.disassembly.isRequired,
        date: disassembly.date || event.disassembly.date,
        arrivalTime: disassembly.arrivalTime || event.disassembly.arrivalTime,
        disassemblyTime: disassembly.disassemblyTime || event.disassembly.disassemblyTime,
        notes: disassembly.notes || event.disassembly.notes
      };
    }

    if (assignedDriver) {
      const driver = await User.findById(assignedDriver).lean();
      if (!driver) {
        return res.status(404).json({ error: 'Driver not found' });
      }
      event.assignedDriver = assignedDriver;
      event.driverName = `${driver.profile?.firstName || ''} ${driver.profile?.lastName || ''}`.trim();
      event.status = 'assigned';
    }

    if (event.companyName === 'Yellow Block') {
      const currentAssetsUsed = Array.isArray(event.logistics?.assetsUsed) ? event.logistics.assetsUsed : [];

      // When event is completed, assets are returned to stock.
      if (oldStatus !== 'completed' && event.status === 'completed' && event.logistics.assetsCheckedOut) {
        await restoreAssetUsage(currentAssetsUsed);
        event.logistics.assetsCheckedOut = false;
      }

      // If a completed event is reopened, check out assets again.
      if (oldStatus === 'completed' && event.status !== 'completed' && !event.logistics.assetsCheckedOut && currentAssetsUsed.length > 0) {
        const enrichedAssetsUsed = await applyAssetUsage({
          assetsUsed: currentAssetsUsed,
          event,
          userId: req.user._id,
          note: 'Asset usage after reopening completed event',
        });
        event.logistics.assetsUsed = enrichedAssetsUsed;
        event.logistics.assetsCheckedOut = enrichedAssetsUsed.length > 0;
      }
    }

    await event.save();

    // Send Slack notification if status changed (non-blocking)
    const newStatus = event.status;
    if (newStatus !== oldStatus) {
      notifyEventStatusChange(event, oldStatus, newStatus).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Event updated successfully',
      event
    });
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/events/:id
 * Delete event
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (event.companyName === 'Yellow Block' && event.logistics?.assetsCheckedOut) {
      const assetsUsed = Array.isArray(event.logistics?.assetsUsed) ? event.logistics.assetsUsed : [];
      await restoreAssetUsage(assetsUsed);
    }

    await Event.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Event deleted successfully'
    });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/events/:id/assign-driver
 * Assign driver to event
 */
router.post('/:id/assign-driver', auth, async (req, res) => {
  try {
    const { driverId } = req.body;

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const driver = await User.findById(driverId).lean();
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    event.assignedDriver = driverId;
    event.driverName = `${driver.profile?.firstName || ''} ${driver.profile?.lastName || ''}`.trim();
    event.status = 'assigned';

    await event.save();

    res.json({
      success: true,
      message: `Event assigned to ${event.driverName}`,
      event
    });
  } catch (error) {
    console.error('Assign driver error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
