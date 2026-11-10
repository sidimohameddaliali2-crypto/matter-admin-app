import express from 'express';
import https from 'https';
import { protect, authorize } from '../middleware/auth.js';
import User from '../models/User.js';
import ThirdPartyDeliveryCompany from '../models/ThirdPartyDeliveryCompany.js';
import ThirdPartyDeliveryAssignment from '../models/ThirdPartyDeliveryAssignment.js';
import YellowblockAsset from '../models/YellowblockAsset.js';
import YellowblockAssetUsage from '../models/YellowblockAssetUsage.js';

const router = express.Router();

router.use(protect);
router.use(authorize(['super_admin', 'admin', 'yellowblock_user']));

// ─── Shopify helper ────────────────────────────────────────────────────────────

function getShopifyConfig() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const useDynamicToken = process.env.SHOPIFY_USE_DYNAMIC_TOKEN === 'true';
  const version = process.env.SHOPIFY_API_VERSION || '2024-01';
  return {
    domain,
    token,
    clientId,
    clientSecret,
    useDynamicToken,
    version,
    configured: !!(domain && (token || (useDynamicToken && clientId && clientSecret))),
  };
}

let cachedShopifyToken = null;
let cachedShopifyTokenExpiresAt = 0;

function requestShopifyToken({ domain, clientId, clientSecret }) {
  return new Promise((resolve, reject) => {
    const postBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: String(clientId || ''),
      client_secret: String(clientSecret || ''),
    }).toString();

    const options = {
      hostname: domain.replace(/^https?:\/\//, ''),
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode !== 200 || !parsed?.access_token) {
            return reject(new Error(parsed?.error_description || parsed?.error || 'Failed to get Shopify access token'));
          }

          const expiresInSec = Number(parsed.expires_in || 23 * 60 * 60);
          resolve({
            accessToken: parsed.access_token,
            expiresAt: Date.now() + (Math.max(expiresInSec, 60) * 1000),
          });
        } catch {
          reject(new Error('Invalid token response from Shopify'));
        }
      });
    });

    req.on('error', reject);
    req.write(postBody);
    req.end();
  });
}

async function getShopifyAccessToken(shopifyConfig) {
  if (shopifyConfig.useDynamicToken) {
    if (!shopifyConfig.clientId || !shopifyConfig.clientSecret) {
      throw new Error('Missing Shopify credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET');
    }

    const now = Date.now();
    if (cachedShopifyToken && cachedShopifyTokenExpiresAt > now + 60 * 1000) {
      return cachedShopifyToken;
    }

    const tokenResult = await requestShopifyToken(shopifyConfig);
    cachedShopifyToken = tokenResult.accessToken;
    cachedShopifyTokenExpiresAt = tokenResult.expiresAt;
    return cachedShopifyToken;
  }

  if (shopifyConfig.token) return shopifyConfig.token;

  if (!shopifyConfig.useDynamicToken && !shopifyConfig.token) {
    throw new Error('Missing SHOPIFY_ADMIN_API_TOKEN. Dynamic token flow is disabled.');
  }

  return shopifyConfig.token;
}

async function shopifyRequest(path, shopifyConfig) {
  const { domain } = shopifyConfig;
  const token = await getShopifyAccessToken(shopifyConfig);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: domain.replace(/^https?:\/\//, ''),
      path,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          reject(new Error('Invalid JSON from Shopify'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchProductImageById(productId, shopifyConfig) {
  const { status: httpStatus, body } = await shopifyRequest(
    `/admin/api/${shopifyConfig.version}/products/${productId}.json`,
    shopifyConfig
  );

  if (httpStatus !== 200 || !body?.product) return '';

  // Prefer featured image first, then first image in gallery.
  return body.product.image?.src || body.product.images?.[0]?.src || '';
}

async function fetchShopifyOrderById(orderId, shopifyConfig) {
  const { status: httpStatus, body } = await shopifyRequest(
    `/admin/api/${shopifyConfig.version}/orders/${orderId}.json`,
    shopifyConfig
  );

  if (httpStatus !== 200 || !body?.order) return null;
  return body.order;
}

function toSafeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      title: String(item?.title || item?.name || '').trim(),
      quantity: Number(item?.quantity) > 0 ? Number(item.quantity) : 1,
    }))
    .filter((item) => item.title);
}

function getCustomerName(orderInput = {}, shopifyOrder = null) {
  if (orderInput.customerName) return String(orderInput.customerName);
  const c = shopifyOrder?.customer;
  if (c) {
    const full = `${c.first_name || ''} ${c.last_name || ''}`.trim();
    if (full) return full;
  }
  return 'Guest';
}

function getCustomerPhone(orderInput = {}, shopifyOrder = null) {
  return String(
    orderInput.customerPhone
      || shopifyOrder?.phone
      || shopifyOrder?.customer?.phone
      || shopifyOrder?.shipping_address?.phone
      || shopifyOrder?.billing_address?.phone
      || ''
  );
}

function getOrderItems(orderInput = {}, shopifyOrder = null) {
  const inputItems = toSafeItems(orderInput.items);
  if (inputItems.length) return inputItems;
  return toSafeItems(shopifyOrder?.line_items || []);
}

function handleShopifyUpstreamError(res, httpStatus, body, fallbackMessage = 'Shopify API error') {
  if (httpStatus === 401 || httpStatus === 403) {
    return res.status(502).json({
      success: false,
      code: 'SHOPIFY_AUTH_FAILED',
      message: 'Shopify authentication failed. Verify SHOPIFY_ADMIN_API_TOKEN and app scopes.',
      upstreamStatus: httpStatus,
      details: body,
    });
  }

  if (httpStatus === 429) {
    return res.status(429).json({
      success: false,
      code: 'SHOPIFY_RATE_LIMIT',
      message: 'Shopify rate limit reached. Please retry shortly.',
      upstreamStatus: httpStatus,
      details: body,
    });
  }

  return res.status(httpStatus).json({
    success: false,
    message: fallbackMessage,
    upstreamStatus: httpStatus,
    details: body,
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/yellowblock/config-status — check if Shopify is configured
router.get('/config-status', (req, res) => {
  const { configured } = getShopifyConfig();
  res.json({ success: true, configured });
});

// GET /api/yellowblock/assets
router.get('/assets', async (req, res) => {
  try {
    const companyName = req.query.companyName || 'Yellow Block';
    const includeInactive = req.query.includeInactive === 'true';
    const search = String(req.query.search || '').trim();

    const filter = { companyName };
    if (!includeInactive) filter.isActive = true;
    if (search) {
      filter.$or = [
        { itemType: { $regex: search, $options: 'i' } },
        { material: { $regex: search, $options: 'i' } },
        { placeOfStorage: { $regex: search, $options: 'i' } },
      ];
    }

    const assets = await YellowblockAsset.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, assets });
  } catch (error) {
    console.error('[YellowBlock] assets list error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/yellowblock/assets
router.post('/assets', async (req, res) => {
  try {
    const itemType = String(req.body?.itemType || '').trim();
    const itemName = String(req.body?.itemName || '').trim();
    const dimension = String(req.body?.dimension || '').trim();
    const material = String(req.body?.material || '').trim();
    const placeOfStorage = String(req.body?.placeOfStorage || '').trim();
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const companyName = String(req.body?.companyName || 'Yellow Block').trim();
    const unitPrice = Number(req.body?.unitPrice || 0);
    const totalCountAvailable = Number(req.body?.totalCountAvailable || 0);

    if (!itemType) {
      return res.status(400).json({ success: false, message: 'Item Type is required' });
    }

    const asset = await YellowblockAsset.create({
      itemType,
      itemName,
      dimension,
      material,
      placeOfStorage,
      imageUrl,
      companyName,
      unitPrice,
      totalCountAvailable,
      totalPrice: unitPrice * totalCountAvailable,
      totalCountUsed: 0,
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, asset });
  } catch (error) {
    console.error('[YellowBlock] assets create error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/yellowblock/assets/bulk
// Bulk-import assets parsed client-side from an uploaded Excel file (see
// AssetManagementView's "Upload Excel" button). Unlike the single-create
// route above, this accepts an initial `totalCountUsed` per row — the one
// place manually entering "already used" makes sense, since bulk import is
// how existing real-world inventory (which may already have some used) gets
// digitized in the first place. `totalPrice` is still always recomputed
// server-side (unitPrice x totalCountAvailable), never trusted from the file,
// so it can never drift from the two numbers it's derived from.
router.post('/assets/bulk', async (req, res) => {
  try {
    const { assets } = req.body || {};
    if (!Array.isArray(assets) || assets.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide an array of assets' });
    }

    const docs = [];
    const errors = [];

    assets.forEach((row, index) => {
      const itemType = String(row?.itemType || '').trim();
      const dimension = String(row?.dimension || '').trim();
      // index + 2: header row is row 1, first data row is row 2.
      const rowLabel = `Row ${index + 2}`;

      if (!itemType) {
        errors.push(`${rowLabel}: Item Type is required — skipped.`);
        return;
      }

      const unitPrice = Number(row?.unitPrice || 0);
      const totalCountAvailable = Number(row?.totalCountAvailable || 0);
      const totalCountUsed = Number(row?.totalCountUsed || 0);

      docs.push({
        imageUrl: String(row?.imageUrl || '').trim(),
        itemType,
        itemName: String(row?.itemName || '').trim(),
        dimension,
        material: String(row?.material || '').trim(),
        placeOfStorage: String(row?.placeOfStorage || '').trim(),
        companyName: 'Yellow Block',
        unitPrice,
        totalCountAvailable,
        totalCountUsed,
        totalPrice: unitPrice * totalCountAvailable,
        createdBy: req.user._id,
      });
    });

    let created = 0;
    if (docs.length > 0) {
      const inserted = await YellowblockAsset.insertMany(docs, { ordered: false });
      created = inserted.length;
    }

    res.json({
      success: true,
      message: `Imported ${created} asset${created === 1 ? '' : 's'}${errors.length ? `, ${errors.length} row${errors.length === 1 ? '' : 's'} skipped` : ''}`,
      created,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('[YellowBlock] assets bulk import error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /api/yellowblock/assets/:id
router.patch('/assets/:id', async (req, res) => {
  try {
    const payload = {
      itemType: req.body?.itemType,
      itemName: req.body?.itemName,
      dimension: req.body?.dimension,
      material: req.body?.material,
      placeOfStorage: req.body?.placeOfStorage,
      imageUrl: req.body?.imageUrl,
      isActive: req.body?.isActive,
    };

    if (req.body?.unitPrice !== undefined) payload.unitPrice = Number(req.body.unitPrice || 0);
    if (req.body?.totalCountAvailable !== undefined) payload.totalCountAvailable = Number(req.body.totalCountAvailable || 0);

    const existing = await YellowblockAsset.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Asset not found' });
    }

    if (payload.totalCountAvailable !== undefined && payload.totalCountAvailable < 0) {
      return res.status(400).json({ success: false, message: 'Available count cannot be negative' });
    }

    const nextUnitPrice = payload.unitPrice !== undefined ? payload.unitPrice : existing.unitPrice;
    const nextAvailable = payload.totalCountAvailable !== undefined ? payload.totalCountAvailable : existing.totalCountAvailable;
    payload.totalPrice = nextUnitPrice * nextAvailable;

    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const asset = await YellowblockAsset.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true });
    res.json({ success: true, asset });
  } catch (error) {
    console.error('[YellowBlock] assets update error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/assets/:id/usage-logs
router.get('/assets/:id/usage-logs', async (req, res) => {
  try {
    const logs = await YellowblockAssetUsage.find({ assetId: req.params.id })
      .sort({ usedAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 200, 1000))
      .lean();

    res.json({ success: true, logs });
  } catch (error) {
    console.error('[YellowBlock] asset usage logs error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/assets-usage-stats
router.get('/assets-usage-stats', async (req, res) => {
  try {
    const companyName = req.query.companyName || 'Yellow Block';
    const assets = await YellowblockAsset.find({ companyName, isActive: true }).lean();

    const totalAssets = assets.length;
    const totalUsedUnits = assets.reduce((sum, asset) => sum + (asset.totalCountUsed || 0), 0);
    const lowStockAssets = assets.filter((asset) => (asset.totalCountAvailable || 0) <= 3).length;

    res.json({ success: true, stats: { totalAssets, totalUsedUnits, lowStockAssets } });
  } catch (error) {
    console.error('[YellowBlock] assets usage stats error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/orders
// Query params: status (open|closed|any), limit (max 250), page_info (cursor)
router.get('/orders', async (req, res) => {
  try {
    const cfg = getShopifyConfig();
    if (!cfg.configured) {
      return res.status(503).json({ success: false, message: 'Shopify is not configured. Add SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_TOKEN to server .env (recommended). Dynamic token flow only works when SHOPIFY_USE_DYNAMIC_TOKEN=true.' });
    }

    const status = req.query.status || 'any';
    const limit = Math.min(Number(req.query.limit) || 50, 250);
    const pageInfo = req.query.page_info;

    let qs = `?status=${status}&limit=${limit}`;
    if (pageInfo) qs += `&page_info=${pageInfo}`;

    const { status: httpStatus, headers, body } = await shopifyRequest(
      `/admin/api/${cfg.version}/orders.json${qs}`,
      cfg
    );

    if (httpStatus !== 200) {
      return handleShopifyUpstreamError(res, httpStatus, body, 'Shopify API error');
    }

    // Extract cursor pagination from Link header
    const linkHeader = headers.link || '';
    const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    const prevMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="previous"/);

    res.json({
      success: true,
      orders: body.orders,
      pagination: {
        nextPageInfo: nextMatch ? nextMatch[1] : null,
        prevPageInfo: prevMatch ? prevMatch[1] : null,
        limit,
      },
    });
  } catch (error) {
    console.error('[YellowBlock] orders error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    const cfg = getShopifyConfig();
    if (!cfg.configured) {
      return res.status(503).json({ success: false, message: 'Shopify is not configured' });
    }

    const { status: httpStatus, body } = await shopifyRequest(
      `/admin/api/${cfg.version}/orders/${req.params.id}.json`,
      cfg
    );

    if (httpStatus !== 200) {
      return handleShopifyUpstreamError(res, httpStatus, body, 'Order not found');
    }

    const order = body.order;
    const productIds = [...new Set(
      (order.line_items || [])
        .map((item) => item.product_id)
        .filter(Boolean)
    )];

    const productImageById = {};

    await Promise.all(productIds.map(async (productId) => {
      try {
        const imageSrc = await fetchProductImageById(productId, cfg);
        if (imageSrc) {
          productImageById[String(productId)] = imageSrc;
        }
      } catch (err) {
        console.warn(`[YellowBlock] product image fetch failed for ${productId}:`, err.message);
      }
    }));

    const enrichedOrder = {
      ...order,
      line_items: (order.line_items || []).map((item) => ({
        ...item,
        product_image: productImageById[String(item.product_id)] || item.product_image || '',
      })),
    };

    res.json({ success: true, order: enrichedOrder });
  } catch (error) {
    console.error('[YellowBlock] order detail error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/products
// Query params: limit, page_info, title (search)
router.get('/products', async (req, res) => {
  try {
    const cfg = getShopifyConfig();
    if (!cfg.configured) {
      return res.status(503).json({ success: false, message: 'Shopify is not configured' });
    }

    const limit = Math.min(Number(req.query.limit) || 50, 250);
    const pageInfo = req.query.page_info;
    const title = req.query.title;

    let qs = `?limit=${limit}`;
    if (pageInfo) qs += `&page_info=${pageInfo}`;
    if (title) qs += `&title=${encodeURIComponent(title)}`;

    const { status: httpStatus, headers, body } = await shopifyRequest(
      `/admin/api/${cfg.version}/products.json${qs}`,
      cfg
    );

    if (httpStatus !== 200) {
      return handleShopifyUpstreamError(res, httpStatus, body, 'Shopify API error');
    }

    const linkHeader = headers.link || '';
    const nextMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    const prevMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="previous"/);

    res.json({
      success: true,
      products: body.products,
      pagination: {
        nextPageInfo: nextMatch ? nextMatch[1] : null,
        prevPageInfo: prevMatch ? prevMatch[1] : null,
        limit,
      },
    });
  } catch (error) {
    console.error('[YellowBlock] products error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/drivers — return active drivers for assignment dropdown
router.get('/drivers', async (req, res) => {
  try {
    const drivers = await User.find({ role: 'driver', isActive: true })
      .select('profile.firstName profile.lastName profile.phone profile.colorCode name email')
      .lean();

    res.json({ success: true, drivers });
  } catch (error) {
    console.error('[YellowBlock] drivers error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/third-party-companies
router.get('/third-party-companies', async (req, res) => {
  try {
    const companies = await ThirdPartyDeliveryCompany.find({})
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, companies });
  } catch (error) {
    console.error('[YellowBlock] third-party companies list error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/yellowblock/third-party-companies
router.post('/third-party-companies', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const logoUrl = String(req.body?.logoUrl || '').trim();
    const whatsappNumber = String(req.body?.whatsappNumber || '').trim();

    if (!name) {
      return res.status(400).json({ success: false, message: 'Company name is required' });
    }

    if (!logoUrl) {
      return res.status(400).json({ success: false, message: 'Company logo is required' });
    }

    if (!whatsappNumber) {
      return res.status(400).json({ success: false, message: 'Company WhatsApp number is required' });
    }

    const company = await ThirdPartyDeliveryCompany.create({
      name,
      logoUrl,
      whatsappNumber,
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, company });
  } catch (error) {
    console.error('[YellowBlock] third-party company create error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/yellowblock/third-party-assignments
router.get('/third-party-assignments', async (req, res) => {
  try {
    const assignments = await ThirdPartyDeliveryAssignment.find({})
      .populate('company', 'name logoUrl whatsappNumber')
      .sort({ assignedAt: -1 })
      .lean();

    const cfg = getShopifyConfig();

    const enrichedAssignments = await Promise.all(assignments.map(async (assignment) => {
      const needsEnrichment = !assignment.customerPhone || !Array.isArray(assignment.items) || assignment.items.length === 0;
      if (!needsEnrichment || !cfg.configured) return assignment;

      try {
        const shopifyOrder = await fetchShopifyOrderById(assignment.shopifyOrderId, cfg);
        if (!shopifyOrder) return assignment;

        const customerPhone = getCustomerPhone({}, shopifyOrder);
        const items = getOrderItems({}, shopifyOrder);

        // Update DB in background-friendly path so next reads are fully populated.
        await ThirdPartyDeliveryAssignment.updateOne(
          { _id: assignment._id },
          {
            $set: {
              customerPhone: customerPhone || assignment.customerPhone || '',
              items: items.length ? items : assignment.items || [],
            },
          }
        );

        return {
          ...assignment,
          customerPhone: customerPhone || assignment.customerPhone || '',
          items: items.length ? items : assignment.items || [],
        };
      } catch (err) {
        console.warn(`[YellowBlock] assignment enrichment failed for order ${assignment.shopifyOrderId}:`, err.message);
        return assignment;
      }
    }));

    res.json({ success: true, assignments: enrichedAssignments });
  } catch (error) {
    console.error('[YellowBlock] third-party assignments list error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/yellowblock/third-party-assignments
router.post('/third-party-assignments', async (req, res) => {
  try {
    const companyId = String(req.body?.companyId || '').trim();
    const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Company is required' });
    }

    if (orders.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one order is required' });
    }

    const company = await ThirdPartyDeliveryCompany.findById(companyId).lean();
    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    const cfg = getShopifyConfig();
    const validOrders = orders.filter((order) => order?.id);

    const operations = await Promise.all(validOrders.map(async (orderInput) => {
      let shopifyOrder = null;

      if (cfg.configured) {
        try {
          shopifyOrder = await fetchShopifyOrderById(orderInput.id, cfg);
        } catch (err) {
          console.warn(`[YellowBlock] unable to enrich assignment order ${orderInput.id}:`, err.message);
        }
      }

      return {
        updateOne: {
          filter: { shopifyOrderId: String(orderInput.id) },
          update: {
            $set: {
              shopifyOrderId: String(orderInput.id),
              orderNumber: String(orderInput.orderNumber || shopifyOrder?.order_number || shopifyOrder?.name || ''),
              customerName: getCustomerName(orderInput, shopifyOrder),
              customerPhone: getCustomerPhone(orderInput, shopifyOrder),
              city: String(orderInput.city || shopifyOrder?.shipping_address?.city || ''),
              addressLine1: String(orderInput.addressLine1 || shopifyOrder?.shipping_address?.address1 || ''),
              items: getOrderItems(orderInput, shopifyOrder),
              company: companyId,
              assignedBy: req.user._id,
              assignedAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    }));

    if (operations.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid orders found' });
    }

    await ThirdPartyDeliveryAssignment.bulkWrite(operations, { ordered: false });

    res.status(201).json({
      success: true,
      message: 'Orders assigned successfully',
      assignedCount: operations.length,
    });
  } catch (error) {
    console.error('[YellowBlock] third-party assignments create error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
