import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  fetchYellowblockConfigStatus,
  fetchYellowblockOrderDetail,
  fetchYellowblockProducts,
  fetchYellowblockAssets,
  createYellowblockAsset,
  updateYellowblockAsset,
  bulkUploadYellowblockAssets,
  fetchYellowblockAssetUsageLogs,
  fetchYellowblockAssetUsageStats,
  fetchThirdPartyCompanies,
  fetchThirdPartyAssignments,
  createThirdPartyCompany,
  clearSelectedOrder,
  clearError,
} from '../store/slices/yellowblockSlice';
import Events from './Events';
import { KITCHEN_PATH } from '../utils/yellowblockKitchenPaths';
import YellowblockOrderWorkflow from '../components/deliveries/YellowblockOrderWorkflow';
import YellowblockInvoiceGenerator from '../components/YellowblockInvoiceGenerator';
import ShopifyShippingMap from '../components/deliveries/ShopifyShippingMap';
import YellowblockDeliveryCalendar from '../components/deliveries/YellowblockDeliveryCalendar';
import { logout } from '../store/slices/authSlice';
import {
  ShoppingBag,
  Package,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Search,
  RefreshCw,
  AlertTriangle,
  X,
  User,
  Tag,
  Grid,
  MapPin,
  Boxes,
  Plus,
  Pencil,
  PackageSearch,
  Building2,
  Calendar,
  UtensilsCrossed,
  Upload,
  Download,
  MessageCircle,
  FileText,
  Menu,
} from 'lucide-react';
import XLSX from 'xlsx-js-style';
import './YellowblockApp.css';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FULFILLMENT_COLORS = {
  fulfilled: 'bg-emerald-100 text-emerald-700',
  partial: 'bg-yellow-100 text-yellow-700',
  null: 'bg-gray-100 text-gray-500',
  unfulfilled: 'bg-orange-100 text-orange-700',
};

const formatCurrency = (amount, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
};

const formatDate = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const getPaymentBadge = (financialStatus) => {
  const normalized = (financialStatus || '').toLowerCase();
  if (normalized === 'paid' || normalized === 'partially_paid') {
    return { text: 'Paid', colorClass: 'bg-emerald-100 text-emerald-700' };
  }
  return { text: 'Unpaid', colorClass: 'bg-red-100 text-red-700' };
};

const getLineItemImageSrc = (item) => {
  if (!item) return '';
  if (typeof item.image === 'string' && item.image) return item.image;
  if (item.image?.src) return item.image.src;
  if (item.image_url) return item.image_url;
  if (item.product_image) return item.product_image;
  return '';
};

const normalizeWhatsappNumber = (value) => String(value || '').replace(/\D/g, '');
const DEFAULT_WHATSAPP_NUMBER = '+971553263196';

const buildAssignmentWhatsappMessage = (assignment) => {
  const itemsText = (assignment.items || []).length
    ? assignment.items.map((item) => `- ${item.title} x${item.quantity}`).join('\n')
    : '- No items listed';

  return [
    'New delivery assignment',
    '',
    `Order: #${assignment.orderNumber || assignment.shopifyOrderId}`,
    `Name: ${assignment.customerName || 'Guest'}`,
    `Number: ${assignment.customerPhone || 'N/A'}`,
    `Address: ${assignment.addressLine1 || 'N/A'}, ${assignment.city || 'N/A'}`,
    'Items:',
    itemsText,
  ].join('\n');
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const Badge = ({ text, colorClass }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${colorClass}`}>
    {text || '—'}
  </span>
);

const Spinner = ({ size = 'md' }) => {
  const cls = size === 'sm' ? 'w-4 h-4' : 'w-8 h-8';
  return <div className={`${cls} border-2 border-yellow-400 border-t-transparent rounded-full animate-spin`} />;
};

const NotConfigured = () => (
  <div className="flex flex-col items-center justify-center flex-1 p-12 text-center">
    <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mb-4">
      <AlertTriangle className="w-8 h-8 text-yellow-500" />
    </div>
    <h2 className="text-xl font-semibold text-gray-800 mb-2">Shopify Not Configured</h2>
    <p className="text-gray-500 max-w-sm">
      Add the following environment variables to your server <code className="bg-gray-100 px-1 rounded text-sm">.env</code> file and restart the server:
    </p>
    <pre className="mt-4 bg-gray-900 text-green-400 text-sm rounded-xl p-4 text-left w-full max-w-md">
{`SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxxx
SHOPIFY_API_VERSION=2024-01`}
    </pre>
  </div>
);

// ─── Order Detail Modal ────────────────────────────────────────────────────────

const OrderDetailModal = ({ order, onClose, allowAssignment }) => {
  const paymentBadge = getPaymentBadge(order?.financial_status);

  if (!order) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="yb-panel shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="yb-view-toolbar flex items-center justify-between p-5">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Order #{order.order_number}</h2>
            <p className="text-sm text-gray-500">{order.name} · {formatDate(order.created_at)}</p>
          </div>
          <button onClick={onClose} aria-label="Close order details" className="yb-icon-button">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* Status row */}
          <div className="flex flex-wrap gap-2">
            <Badge text={paymentBadge.text} colorClass={paymentBadge.colorClass} />
            <Badge
              text={order.fulfillment_status || 'unfulfilled'}
              colorClass={FULFILLMENT_COLORS[order.fulfillment_status] || FULFILLMENT_COLORS.unfulfilled}
            />
          </div>

          <YellowblockOrderWorkflow key={order.id} id={String(order.id)} allowAssignment={allowAssignment} />

          {/* Customer */}
          {order.customer && (
            <div className="bg-gray-50 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-gray-600 mb-2 flex items-center gap-1.5">
                <User className="w-4 h-4" /> Customer
              </h3>
              <p className="text-sm text-gray-900 font-medium">
                {order.customer.first_name} {order.customer.last_name}
              </p>
              <p className="text-sm text-gray-500">{order.customer.email}</p>
              {order.customer.phone && (
                <p className="text-sm text-gray-500">{order.customer.phone}</p>
              )}
            </div>
          )}

          {/* Shipping Address */}
          {order.shipping_address && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-blue-700 mb-3 flex items-center gap-1.5">
                <MapPin className="w-4 h-4" /> Shipping Address
              </h3>
              <div className="space-y-1 text-sm">
                {(order.shipping_address.first_name || order.shipping_address.last_name) && (
                  <p className="font-semibold text-gray-900">
                    {order.shipping_address.first_name} {order.shipping_address.last_name}
                  </p>
                )}
                {order.shipping_address.company && (
                  <p className="text-gray-600">{order.shipping_address.company}</p>
                )}
                <p className="text-gray-800">{order.shipping_address.address1}</p>
                {order.shipping_address.address2 && (
                  <p className="text-gray-800">{order.shipping_address.address2}</p>
                )}
                <p className="text-gray-800">
                  {[order.shipping_address.city, order.shipping_address.province_code || order.shipping_address.province, order.shipping_address.zip]
                    .filter(Boolean).join(', ')}
                </p>
                <p className="text-gray-800 font-medium">{order.shipping_address.country}</p>
                {order.shipping_address.phone && (
                  <p className="text-gray-600 mt-1 flex items-center gap-1">
                    <span className="text-xs text-blue-500 font-semibold">TEL</span>
                    {order.shipping_address.phone}
                  </p>
                )}
              </div>
              <ShopifyShippingMap address={order.shipping_address} />
            </div>
          )}

          {/* Line items */}
          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2 flex items-center gap-1.5">
              <Package className="w-4 h-4" /> Items ({order.line_items?.length || 0})
            </h3>
            <div className="space-y-2">
              {(order.line_items || []).map((item) => {
                const itemImage = getLineItemImageSrc(item);
                return (
                  <div key={item.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm gap-3">
                    <div className="w-12 h-12 rounded-lg bg-gray-100 border border-gray-200 overflow-hidden shrink-0 flex items-center justify-center">
                      {itemImage ? (
                        <img
                          src={itemImage}
                          alt={item.title || 'Item image'}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Package className="w-5 h-5 text-gray-400" />
                      )}
                    </div>
                    <span className="text-gray-800 font-medium flex-1">{item.title}</span>
                    <span className="text-gray-500 ml-2">×{item.quantity}</span>
                    <span className="text-gray-900 font-semibold ml-4">{formatCurrency(item.price, order.currency)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Total */}
          <div className="flex items-center justify-between py-2 border-t border-gray-100">
            <span className="text-sm font-semibold text-gray-700">Total</span>
            <span className="text-base font-bold text-gray-900">
              {formatCurrency(order.total_price, order.currency)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Products View ───────────────────────────────────────────────────────────────

const ProductsView = () => {
  const dispatch = useDispatch();
  const { products, productsPagination, productsLoading, error } = useSelector((s) => s.yellowblock);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 500);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    dispatch(fetchYellowblockProducts({ limit: 50, title: debouncedSearch || undefined }));
  }, [dispatch, debouncedSearch]);

  return (
    <div className="yb-panel flex min-w-0 flex-col">
      {/* Toolbar */}
      <div className="yb-view-toolbar flex flex-wrap items-center gap-3 p-4">
        <h2 className="text-base font-bold text-gray-900 mr-auto">Shopify Products</h2>
        <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-1.5 bg-white">
          <Search className="w-3.5 h-3.5 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title…"
            className="text-sm outline-none w-44 placeholder:text-gray-400"
          />
        </div>
        <button
          onClick={() => dispatch(fetchYellowblockProducts({ limit: 50 }))}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-4 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => dispatch(clearError())}><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {productsLoading ? (
          <div className="flex items-center justify-center h-40"><Spinner /></div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400">
            <Tag className="w-10 h-10 mb-2" />
            <p className="text-sm">No products found</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {products.map((product) => (
              <div key={product.id} className="bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition">
                {product.image?.src ? (
                  <img src={product.image.src} alt={product.title} className="w-full h-40 object-cover" />
                ) : (
                  <div className="w-full h-40 bg-gray-100 flex items-center justify-center">
                    <Package className="w-10 h-10 text-gray-300" />
                  </div>
                )}
                <div className="p-3">
                  <p className="text-sm font-semibold text-gray-900 line-clamp-2">{product.title}</p>
                  {product.vendor && (
                    <p className="text-xs text-gray-400 mt-0.5">{product.vendor}</p>
                  )}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-gray-500">{product.variants?.length || 0} variant{product.variants?.length !== 1 ? 's' : ''}</span>
                    {product.variants?.[0]?.price && (
                      <span className="text-sm font-bold text-gray-900">{formatCurrency(product.variants[0].price)}</span>
                    )}
                  </div>
                  <div className="mt-2">
                    <Badge
                      text={product.status}
                      colorClass={product.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {(productsPagination.prevPageInfo || productsPagination.nextPageInfo) && (
        <div className="flex items-center justify-center gap-3 p-4 border-t border-gray-100">
          <button
            onClick={() => dispatch(fetchYellowblockProducts({ pageInfo: productsPagination.prevPageInfo }))}
            disabled={!productsPagination.prevPageInfo}
            className="flex items-center gap-1 px-4 py-2 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50 transition"
          >
            <ChevronLeft className="w-4 h-4" /> Prev
          </button>
          <button
            onClick={() => dispatch(fetchYellowblockProducts({ pageInfo: productsPagination.nextPageInfo }))}
            disabled={!productsPagination.nextPageInfo}
            className="flex items-center gap-1 px-4 py-2 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50 transition"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Asset Management View ───────────────────────────────────────────────────

const AssetManagementView = () => {
  const dispatch = useDispatch();
  const {
    assets,
    assetsLoading,
    assetSaving,
    assetUsageStats,
    assetUsageLogsByAssetId,
  } = useSelector((s) => s.yellowblock);

  const [search, setSearch] = useState('');
  const [materialFilter, setMaterialFilter] = useState('');
  const [itemTypeFilter, setItemTypeFilter] = useState('');
  const [showArchived, setShowArchived] = useState(true);
  const [editingAsset, setEditingAsset] = useState(null);
  const [historyAsset, setHistoryAsset] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [formError, setFormError] = useState('');
  const [isImportingAssets, setIsImportingAssets] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSummary, setImportSummary] = useState(null); // { created, errors } | null
  const [assetForm, setAssetForm] = useState({
    imageUrl: '',
    itemType: '',
    itemName: '',
    dimension: '',
    material: '',
    unitPrice: 0,
    totalCountAvailable: 0,
    placeOfStorage: '',
  });

  useEffect(() => {
    dispatch(fetchYellowblockAssets({ includeInactive: showArchived }));
    dispatch(fetchYellowblockAssetUsageStats());
  }, [dispatch, showArchived]);

  useEffect(() => {
    const q = search.trim();
    dispatch(fetchYellowblockAssets({ search: q, includeInactive: showArchived }));
  }, [dispatch, search, showArchived]);

  const totalPrice = Number(assetForm.unitPrice || 0) * Number(assetForm.totalCountAvailable || 0);

  const closeModal = () => {
    setModalOpen(false);
    setEditingAsset(null);
    setFormError('');
    setAssetForm({
      imageUrl: '',
      itemType: '',
      itemName: '',
      dimension: '',
      material: '',
      unitPrice: 0,
      totalCountAvailable: 0,
      placeOfStorage: '',
    });
  };

  const openCreateModal = () => {
    setEditingAsset(null);
    setAssetForm({
      imageUrl: '',
      itemType: '',
      itemName: '',
      dimension: '',
      material: '',
      unitPrice: 0,
      totalCountAvailable: 0,
      placeOfStorage: '',
    });
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (asset) => {
    setEditingAsset(asset);
    setAssetForm({
      imageUrl: asset.imageUrl || '',
      itemType: asset.itemType || '',
      itemName: asset.itemName || '',
      dimension: asset.dimension || '',
      material: asset.material || '',
      unitPrice: Number(asset.unitPrice || 0),
      totalCountAvailable: Number(asset.totalCountAvailable || 0),
      placeOfStorage: asset.placeOfStorage || '',
    });
    setFormError('');
    setModalOpen(true);
    dispatch(fetchYellowblockAssetUsageLogs({ assetId: asset._id, limit: 100 }));
  };

  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });

  const handleImageChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') && !String(file.name || '').toLowerCase().endsWith('.svg')) {
      setFormError('Please upload a valid image file.');
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setAssetForm((prev) => ({ ...prev, imageUrl: dataUrl }));
  };

  const handleSaveAsset = async (event) => {
    event.preventDefault();
    if (!assetForm.itemType.trim()) {
      setFormError('Item Type is required.');
      return;
    }

    const payload = {
      imageUrl: assetForm.imageUrl,
      itemType: assetForm.itemType.trim(),
      itemName: assetForm.itemName.trim(),
      dimension: assetForm.dimension.trim(),
      material: assetForm.material.trim(),
      unitPrice: Number(assetForm.unitPrice || 0),
      totalCountAvailable: Number(assetForm.totalCountAvailable || 0),
      placeOfStorage: assetForm.placeOfStorage.trim(),
    };

    const result = editingAsset
      ? await dispatch(updateYellowblockAsset({ id: editingAsset._id, data: payload }))
      : await dispatch(createYellowblockAsset(payload));

    if (updateYellowblockAsset.rejected.match(result) || createYellowblockAsset.rejected.match(result)) {
      setFormError(result.payload || 'Failed to save asset');
      return;
    }

    closeModal();
    dispatch(fetchYellowblockAssets({ search, includeInactive: showArchived }));
    dispatch(fetchYellowblockAssetUsageStats());
  };

  const ASSET_UPLOAD_HEADERS = [
    'IMAGE', 'ITEM TYPE', 'ITEM NAME', 'DIMENSION', 'MATERIAL',
    'UNIT PRICE', 'TOTAL COUNT AVAILABLE', 'TOTAL PRICE', 'TOTAL COUNTED USED', 'BOX STORED',
  ];

  const handleDownloadAssetTemplate = () => {
    const rows = [
      ASSET_UPLOAD_HEADERS,
      [
        'https://example.com/chair.jpg', 'Furniture', 'Foldable Chair', '45 x 45 x 90 cm', 'Steel',
        45, 100, 4500, 12, 'Box A3',
      ],
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = ASSET_UPLOAD_HEADERS.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Assets Upload');
    XLSX.writeFile(wb, 'yellowblock_assets_template.xlsx');
  };

  // Matches a header to one of several accepted spellings, same approach as
  // the Menu Management bulk-upload parser — tolerant of column reordering
  // and reasonable naming variations.
  const findHeaderIndex = (headerRow, candidates) => {
    const normalized = headerRow.map((h) => String(h || '').trim().toUpperCase());
    for (const candidate of candidates) {
      const idx = normalized.indexOf(candidate);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const handleUploadAssetExcel = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportError('');
    setImportSummary(null);
    setIsImportingAssets(true);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });

      if (!rows.length) {
        throw new Error('The file is empty.');
      }

      const headerRow = rows[0] || [];
      const idx = {
        imageUrl: findHeaderIndex(headerRow, ['IMAGE', 'IMAGE URL', 'IMAGEURL']),
        itemType: findHeaderIndex(headerRow, ['ITEM TYPE', 'TYPE']),
        itemName: findHeaderIndex(headerRow, ['ITEM NAME', 'NAME']),
        dimension: findHeaderIndex(headerRow, ['DIMENSION', 'DIMENSIONS', 'SIZE']),
        material: findHeaderIndex(headerRow, ['MATERIAL']),
        unitPrice: findHeaderIndex(headerRow, ['UNIT PRICE', 'PRICE']),
        totalCountAvailable: findHeaderIndex(headerRow, ['TOTAL COUNT AVAILABLE', 'TOTAL AVAILABLE', 'AVAILABLE', 'QUANTITY', 'QTY']),
        totalCountUsed: findHeaderIndex(headerRow, ['TOTAL COUNTED USED', 'TOTAL COUNT USED', 'TOTAL USED', 'USED']),
        placeOfStorage: findHeaderIndex(headerRow, ['BOX STORED', 'BOX', 'PLACE OF STORAGE', 'STORAGE']),
        // TOTAL PRICE is read from the file only to ignore it — the server
        // always recomputes it from Unit Price x Total Count Available, so
        // it never drifts from the two numbers it's derived from.
      };

      if (idx.itemType === -1) {
        throw new Error('The file must have an "ITEM TYPE" column. Download the template to see the expected format.');
      }

      const dataRows = rows.slice(1).filter((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim() !== ''));
      if (dataRows.length === 0) {
        throw new Error('No asset rows found below the header.');
      }

      const assetsToUpload = dataRows.map((row) => ({
        imageUrl: idx.imageUrl !== -1 ? String(row[idx.imageUrl] || '').trim() : '',
        itemType: String(row[idx.itemType] || '').trim(),
        itemName: idx.itemName !== -1 ? String(row[idx.itemName] || '').trim() : '',
        dimension: idx.dimension !== -1 ? String(row[idx.dimension] || '').trim() : '',
        material: idx.material !== -1 ? String(row[idx.material] || '').trim() : '',
        unitPrice: idx.unitPrice !== -1 ? Number(row[idx.unitPrice] || 0) : 0,
        totalCountAvailable: idx.totalCountAvailable !== -1 ? Number(row[idx.totalCountAvailable] || 0) : 0,
        totalCountUsed: idx.totalCountUsed !== -1 ? Number(row[idx.totalCountUsed] || 0) : 0,
        placeOfStorage: idx.placeOfStorage !== -1 ? String(row[idx.placeOfStorage] || '').trim() : '',
      }));

      const result = await dispatch(bulkUploadYellowblockAssets(assetsToUpload));
      if (bulkUploadYellowblockAssets.rejected.match(result)) {
        throw new Error(result.payload || 'Failed to import assets');
      }

      setImportSummary(result.payload);
      dispatch(fetchYellowblockAssets({ search, includeInactive: showArchived }));
      dispatch(fetchYellowblockAssetUsageStats());
    } catch (err) {
      setImportError(err.message || 'Failed to import the file.');
    } finally {
      setIsImportingAssets(false);
      event.target.value = '';
    }
  };

  const handleArchiveToggle = async (asset) => {
    await dispatch(updateYellowblockAsset({ id: asset._id, data: { isActive: !asset.isActive } }));
    dispatch(fetchYellowblockAssets({ search, includeInactive: showArchived }));
    dispatch(fetchYellowblockAssetUsageStats());
  };

  const openHistoryModal = (asset) => {
    setHistoryAsset(asset);
    dispatch(fetchYellowblockAssetUsageLogs({ assetId: asset._id, limit: 300 }));
  };

  // Distinct materials among the currently-loaded assets, for the Material
  // filter dropdown — free-text field on the asset itself, so options are
  // derived rather than a fixed list.
  const materialOptions = useMemo(
    () => Array.from(new Set(assets.map((a) => String(a.material || '').trim()).filter(Boolean))).sort(),
    [assets]
  );
  const itemTypeOptions = useMemo(
    () => Array.from(new Set(assets.map((a) => String(a.itemType || '').trim()).filter(Boolean))).sort(),
    [assets]
  );
  const visibleAssets = assets.filter(
    (a) =>
      (!materialFilter || String(a.material || '').trim() === materialFilter) &&
      (!itemTypeFilter || String(a.itemType || '').trim() === itemTypeFilter)
  );

  return (
    <div className="yb-panel flex min-w-0 flex-col">
      <div className="yb-view-toolbar flex flex-wrap items-center gap-3 p-4">
        <h2 className="text-base font-bold text-gray-900 mr-auto">Asset Management</h2>
        <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-1.5 bg-white">
          <Search className="w-3.5 h-3.5 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assets..."
            className="text-sm outline-none w-48 placeholder:text-gray-400"
          />
        </div>
        <select
          value={materialFilter}
          onChange={(e) => setMaterialFilter(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-600 outline-none"
        >
          <option value="">All Materials</option>
          {materialOptions.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select
          value={itemTypeFilter}
          onChange={(e) => setItemTypeFilter(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-600 outline-none"
        >
          <option value="">All Item Types</option>
          {itemTypeOptions.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowArchived((prev) => !prev)}
          className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border transition ${
            showArchived
              ? 'border-[#ff5937] text-[#ff5937] bg-orange-50'
              : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
          }`}
        >
          {showArchived ? 'Hide Archived' : 'Show Archived'}
        </button>
        <button
          type="button"
          onClick={handleDownloadAssetTemplate}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition"
          title="Download an Excel template with the expected columns"
        >
          <Download className="w-4 h-4" /> Template
        </button>
        <label className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition cursor-pointer">
          <Upload className="w-4 h-4" /> {isImportingAssets ? 'Importing...' : 'Upload Excel'}
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleUploadAssetExcel}
            disabled={isImportingAssets}
            className="hidden"
          />
        </label>
        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-[#ff5937] text-white hover:opacity-90 transition"
        >
          <Plus className="w-4 h-4" /> Add Asset
        </button>
      </div>

      {(importError || importSummary) && (
        <div className="px-4 pt-3">
          {importError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{importError}</div>
          )}
          {importSummary && (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              Imported {importSummary.created} asset{importSummary.created === 1 ? '' : 's'}.
              {importSummary.errors?.length > 0 && (
                <ul className="mt-1.5 list-disc list-inside text-amber-700">
                  {importSummary.errors.map((msg, i) => <li key={i}>{msg}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4">
        <div className="bg-white border border-gray-100 rounded-xl p-3">
          <p className="text-xs text-gray-500">Total Assets</p>
          <p className="text-xl font-bold text-gray-900">{assetUsageStats.totalAssets || 0}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-3">
          <p className="text-xs text-gray-500">Total Units Used</p>
          <p className="text-xl font-bold text-gray-900">{assetUsageStats.totalUsedUnits || 0}</p>
        </div>
        <div className="bg-white border border-gray-100 rounded-xl p-3">
          <p className="text-xs text-gray-500">Low Stock Assets</p>
          <p className="text-xl font-bold text-red-600">{assetUsageStats.lowStockAssets || 0}</p>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 pb-4">
        {assetsLoading ? (
          <div className="flex items-center justify-center h-40"><Spinner /></div>
        ) : visibleAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400">
            <PackageSearch className="w-10 h-10 mb-2" />
            <p className="text-sm">No assets found</p>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleAssets.map((asset) => {
              const totalUnits = Number(asset.totalCountAvailable || 0) + Number(asset.totalCountUsed || 0);
              const availabilityPercent = totalUnits > 0
                ? Math.round((Number(asset.totalCountAvailable || 0) / totalUnits) * 100)
                : 0;

              return (
              <button
                key={asset._id}
                type="button"
                onClick={() => openHistoryModal(asset)}
                className="w-full text-left bg-white border border-gray-100 rounded-xl p-3 flex items-center gap-3 hover:border-[#ff5937] hover:shadow-sm transition"
              >
                <div className="w-14 h-14 rounded-lg bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
                  {asset.imageUrl ? (
                    <img src={asset.imageUrl} alt={asset.itemType} className="w-full h-full object-cover" />
                  ) : (
                    <Boxes className="w-6 h-6 text-gray-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {asset.itemName || asset.itemType}
                    </p>
                    {asset.itemType && (
                      <Badge text={asset.itemType} colorClass="bg-orange-50 text-[#ff5937] shrink-0" />
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {[asset.material || 'N/A', asset.dimension, asset.placeOfStorage || 'No storage']
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="text-xs text-gray-500">
                    Available: {asset.totalCountAvailable} · Used Units: {asset.totalCountUsed} · Total Price: {formatCurrency(asset.totalPrice || 0)}
                  </p>
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-[11px] font-semibold">
                      <span className={availabilityPercent <= 25 ? 'text-red-600' : availabilityPercent <= 50 ? 'text-amber-600' : 'text-emerald-600'}>
                        Availability {availabilityPercent}%
                      </span>
                      <span className="text-gray-500">{asset.totalCountAvailable}/{totalUnits || 0} units</span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full ${availabilityPercent <= 25 ? 'bg-red-500' : availabilityPercent <= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.max(availabilityPercent, totalUnits > 0 ? 6 : 0)}%` }}
                      />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-center min-w-[90px]">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wide">Available</p>
                    <p className={`text-lg font-bold ${Number(asset.totalCountAvailable || 0) <= 3 ? 'text-red-600' : 'text-gray-900'}`}>
                      {asset.totalCountAvailable}
                    </p>
                  </div>
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                    Used {asset.usageLogs?.length || 0} times
                  </span>
                  <Badge
                    text={asset.isActive ? 'active' : 'archived'}
                    colorClass={asset.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditModal(asset);
                    }}
                    className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                  >
                    <Pencil className="w-4 h-4 text-gray-600" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleArchiveToggle(asset);
                    }}
                    className="px-2 py-1 text-xs rounded-lg border border-gray-200 hover:bg-gray-50"
                  >
                    {asset.isActive ? 'Archive' : 'Activate'}
                  </button>
                </div>
              </button>
            );})}
          </div>
        )}
      </div>

      {historyAsset && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-gray-900">
                    {historyAsset.itemName || historyAsset.itemType || 'Asset History'}
                  </h3>
                  {historyAsset.itemType && (
                    <Badge text={historyAsset.itemType} colorClass="bg-orange-50 text-[#ff5937]" />
                  )}
                </div>
                {historyAsset.dimension && (
                  <p className="text-sm text-gray-500 mt-0.5">{historyAsset.dimension}</p>
                )}
              </div>
              <button onClick={() => setHistoryAsset(null)} className="p-2 hover:bg-gray-100 rounded-lg transition">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Available</p>
                  <p className="text-lg font-bold text-gray-900">{historyAsset.totalCountAvailable}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Used Units</p>
                  <p className="text-lg font-bold text-gray-900">{historyAsset.totalCountUsed}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Usage Records</p>
                  <p className="text-lg font-bold text-gray-900">{assetUsageLogsByAssetId[historyAsset._id]?.length || 0}</p>
                </div>
              </div>

              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-gray-700 mb-2">Used In Events</p>
                <div className="max-h-72 overflow-auto space-y-2">
                  {(assetUsageLogsByAssetId[historyAsset._id] || []).length === 0 ? (
                    <p className="text-sm text-gray-500">No usage history found for this asset yet.</p>
                  ) : (
                    (assetUsageLogsByAssetId[historyAsset._id] || []).map((log) => (
                      <div key={log._id} className="bg-white border border-gray-200 rounded-lg p-3">
                        <p className="text-sm font-semibold text-gray-900">{log.eventName || 'Event'}</p>
                        <p className="text-xs text-gray-600">Used: {log.quantityUsed} {log.unitSnapshot}</p>
                        <p className="text-xs text-gray-500">{formatDate(log.usedAt)}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h3 className="text-base font-bold text-gray-900">{editingAsset ? 'Edit Asset' : 'Create Asset'}</h3>
              <button onClick={closeModal} className="p-2 hover:bg-gray-100 rounded-lg transition">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleSaveAsset} className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Item Type</label>
                  <input
                    value={assetForm.itemType}
                    onChange={(e) => setAssetForm((prev) => ({ ...prev, itemType: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                  <input
                    value={assetForm.itemName}
                    onChange={(e) => setAssetForm((prev) => ({ ...prev, itemName: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Dimension</label>
                  <input
                    value={assetForm.dimension}
                    onChange={(e) => setAssetForm((prev) => ({ ...prev, dimension: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    placeholder="e.g. 10 x 20 x 5 cm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Material</label>
                  <input
                    value={assetForm.material}
                    onChange={(e) => setAssetForm((prev) => ({ ...prev, material: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Place of Storage</label>
                  <input
                    value={assetForm.placeOfStorage}
                    onChange={(e) => setAssetForm((prev) => ({ ...prev, placeOfStorage: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Unit Price</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={assetForm.unitPrice}
                    onChange={(e) => setAssetForm((prev) => ({ ...prev, unitPrice: Number(e.target.value || 0) }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Total Count Available</label>
                  <input
                    type="number"
                    min="0"
                    value={assetForm.totalCountAvailable}
                    onChange={(e) => setAssetForm((prev) => ({ ...prev, totalCountAvailable: Number(e.target.value || 0) }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Total Price</label>
                  <input
                    value={formatCurrency(totalPrice)}
                    disabled
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Total Count Used</label>
                  <input
                    value={editingAsset?.totalCountUsed || 0}
                    disabled
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Image</label>
                <label className="w-full border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-600 bg-gray-50 hover:bg-gray-100 transition flex items-center gap-2 cursor-pointer">
                  <Upload className="w-4 h-4" /> Upload image
                  <input type="file" accept="image/*,.svg,image/svg+xml" onChange={handleImageChange} className="hidden" />
                </label>
                {assetForm.imageUrl && (
                  <div className="w-40 h-24 mt-2 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                    <img src={assetForm.imageUrl} alt="Asset preview" className="w-full h-full object-contain" />
                  </div>
                )}
              </div>

              {editingAsset && assetUsageLogsByAssetId[editingAsset._id]?.length > 0 && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <p className="text-sm font-semibold text-gray-700 mb-2">Usage Logs</p>
                  <div className="max-h-40 overflow-auto space-y-1">
                    {assetUsageLogsByAssetId[editingAsset._id].map((log) => (
                      <div key={log._id} className="text-xs text-gray-600 border-b border-gray-200 pb-1">
                        <p className="font-semibold">{log.eventName || 'Event'} · {log.quantityUsed} used</p>
                        <p>{formatDate(log.usedAt)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {formError && <p className="text-sm text-red-600">{formError}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeModal} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={assetSaving} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#ff5937] text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-50">
                  {assetSaving ? 'Saving...' : 'Save Asset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Third Party Delivery View ───────────────────────────────────────────────

const ThirdPartyDeliveryView = ({ onViewOrder }) => {
  const dispatch = useDispatch();
  const { thirdPartyCompanies, thirdPartyAssignments, thirdPartyLoading, thirdPartySaving } = useSelector((s) => s.yellowblock);
  const [companyName, setCompanyName] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState(DEFAULT_WHATSAPP_NUMBER);
  const [logoPreview, setLogoPreview] = useState('');
  const [formError, setFormError] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  useEffect(() => {
    dispatch(fetchThirdPartyCompanies());
    dispatch(fetchThirdPartyAssignments());
  }, [dispatch]);

  const assignmentsByCompanyId = thirdPartyAssignments.reduce((acc, assignment) => {
    const companyId = assignment.company?._id || assignment.company;
    if (!companyId) return acc;
    if (!acc[companyId]) acc[companyId] = [];
    acc[companyId].push(assignment);
    return acc;
  }, {});
  const assignmentsWithoutProfile = thirdPartyAssignments.filter(assignment => !assignment.company && assignment.courierName);

  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || '');
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });

  const handleLogoChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileName = file.name?.toLowerCase() || '';
    const isSvgByExtension = fileName.endsWith('.svg');
    const isImageMime = file.type?.startsWith('image/');

    if (!isImageMime && !isSvgByExtension) {
      setFormError('Please upload a valid image file.');
      return;
    }

    setFormError('');
    try {
      const dataUrl = await fileToDataUrl(file);
      setLogoPreview(String(dataUrl));
    } catch {
      setFormError('Could not read the selected image.');
    }
  };

  const handleCreateCompanyProfile = async (event) => {
    event.preventDefault();

    const trimmedName = companyName.trim();
    const trimmedWhatsapp = whatsappNumber.trim();
    if (!trimmedName) {
      setFormError('Company name is required.');
      return;
    }

    if (!trimmedWhatsapp) {
      setFormError('WhatsApp number is required.');
      return;
    }

    if (!logoPreview) {
      setFormError('Please upload a company logo.');
      return;
    }

    const resultAction = await dispatch(createThirdPartyCompany({
      name: trimmedName,
      logoUrl: logoPreview,
      whatsappNumber: trimmedWhatsapp,
    }));

    if (createThirdPartyCompany.rejected.match(resultAction)) {
      setFormError(resultAction.payload || 'Failed to create company profile.');
      return;
    }

    setCompanyName('');
    setWhatsappNumber(DEFAULT_WHATSAPP_NUMBER);
    setLogoPreview('');
    setFormError('');
    setIsCreateModalOpen(false);
  };

  const closeCreateModal = () => {
    setIsCreateModalOpen(false);
    setCompanyName('');
    setWhatsappNumber(DEFAULT_WHATSAPP_NUMBER);
    setLogoPreview('');
    setFormError('');
  };

  const handleShareOnWhatsapp = (company, assignment) => {
    const companyWhatsapp = normalizeWhatsappNumber(company?.whatsappNumber || DEFAULT_WHATSAPP_NUMBER);
    if (!companyWhatsapp) {
      window.alert(`Add WhatsApp number for ${company?.name || 'this company'} to share orders.`);
      return;
    }

    const message = buildAssignmentWhatsappMessage(assignment);
    const shareUrl = `https://wa.me/${companyWhatsapp}?text=${encodeURIComponent(message)}`;
    window.open(shareUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="yb-panel flex min-w-0 flex-col">
      <div className="yb-view-toolbar flex flex-wrap items-center gap-3 p-4">
        <h2 className="mr-auto text-base font-bold text-gray-900">Third-party delivery</h2>
        <button
          type="button"
          onClick={() => setIsCreateModalOpen(true)}
          className="yb-button yb-button-primary"
        >
          <Building2 className="w-4 h-4" />
          Create Company Profile
        </button>
      </div>

      <div className="p-4 space-y-4">
        <div className="p-1">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Company Profiles</h3>
          {thirdPartyLoading ? (
            <div className="flex items-center justify-center h-24"><Spinner /></div>
          ) : thirdPartyCompanies.length === 0 ? (
            <p className="text-sm text-gray-500">No company profile created yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {thirdPartyCompanies.map((company) => (
                <div key={company._id} className="border border-gray-100 rounded-xl p-4 bg-gray-50 text-center">
                  <div className="w-full h-20 rounded-lg bg-white border border-gray-200 mb-3 flex items-center justify-center px-2">
                    <img src={company.logoUrl} alt={company.name} className="max-h-14 w-auto object-contain" />
                  </div>
                  <h4 className="text-base font-bold text-gray-900 tracking-tight">{company.name}</h4>
                  {company.whatsappNumber && (
                    <p className="text-xs text-gray-500 mt-1">WhatsApp: {company.whatsappNumber}</p>
                  )}

                  <details className="mt-3 text-left bg-white border border-gray-200 rounded-lg">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-700">
                      Assigned Orders ({(assignmentsByCompanyId[company._id] || []).length})
                    </summary>
                    <div className="px-3 pb-3">
                      {(assignmentsByCompanyId[company._id] || []).length === 0 ? (
                        <p className="text-xs text-gray-500">No orders assigned yet.</p>
                      ) : (
                        <ul className="space-y-1">
                          {(assignmentsByCompanyId[company._id] || []).map((assignment) => (
                            <li key={assignment._id} className="text-xs text-gray-700 border-b border-gray-100 pb-1">
                              <button type="button" onClick={() => onViewOrder(assignment.shopifyOrderId)} className="font-semibold hover:underline">
                                Order {String(assignment.orderNumber || assignment.shopifyOrderId).replace(/^#?/, '#')}
                              </button>
                              <p>{assignment.customerName || 'Guest'}</p>
                              <p className="text-gray-500">{assignment.customerPhone || 'No phone'}</p>
                              <p className="text-gray-500">{assignment.city || '—'} · {assignment.addressLine1 || '—'}</p>
                              <button
                                type="button"
                                onClick={() => handleShareOnWhatsapp(company, assignment)}
                                className="mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-green-100 text-green-700 hover:bg-green-200 transition"
                              >
                                <MessageCircle className="w-3.5 h-3.5" /> Share
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </details>
                </div>
              ))}
            </div>
          )}
        </div>
        {assignmentsWithoutProfile.length > 0 && (
          <section className="p-1">
            <h3 className="mb-3 text-sm font-semibold text-gray-800">Other courier assignments</h3>
            <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
              {assignmentsWithoutProfile.map(assignment => (
                <li key={assignment._id}>
                  <button type="button" onClick={() => onViewOrder(assignment.shopifyOrderId)}
                    className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm hover:bg-orange-50">
                    <span className="font-semibold text-gray-900">Order {String(assignment.orderNumber || assignment.shopifyOrderId).replace(/^#?/, '#')}</span>
                    <span className="text-gray-600">{assignment.courierName}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div className="flex items-center gap-2 text-gray-900">
                <Building2 className="w-5 h-5" />
                <h3 className="text-base font-bold">Create Company Profile</h3>
              </div>
              <button onClick={closeCreateModal} className="p-2 hover:bg-gray-100 rounded-lg transition">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleCreateCompanyProfile} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Enter company name"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">WhatsApp Number</label>
                <input
                  value={whatsappNumber}
                  onChange={(e) => setWhatsappNumber(e.target.value)}
                  placeholder="e.g. +971501234567"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company Logo</label>
                <label className="w-full border border-dashed border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-600 bg-gray-50 hover:bg-gray-100 transition flex items-center gap-2 cursor-pointer">
                  <Upload className="w-4 h-4" />
                  Upload image
                  <input
                    type="file"
                    accept="image/*,.svg,image/svg+xml"
                    onChange={handleLogoChange}
                    className="hidden"
                  />
                </label>
              </div>

              {logoPreview && (
                <div className="w-40 h-24 border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                  <img src={logoPreview} alt="Company logo preview" className="w-full h-full object-contain" />
                </div>
              )}

              {formError && (
                <p className="text-sm text-red-600">{formError}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeCreateModal}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={thirdPartySaving}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#ff5937] text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
                >
                  <Building2 className="w-4 h-4" />
                  {thirdPartySaving ? 'Creating...' : 'Create Profile'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main Shell ───────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { key: 'orders', label: 'Order', icon: ShoppingBag },
  { key: 'invoices', label: 'Invoice Generator', icon: FileText },
  { key: 'kitchen', label: 'Kitchen', icon: UtensilsCrossed },
  { key: 'third_party_delivery', label: 'Third-party delivery', icon: Building2 },
  { key: 'products', label: 'Products', icon: Grid },
  { key: 'asset_management', label: 'Asset Management', icon: Boxes },
  { key: 'events', label: 'Events', icon: Calendar },
];

const YellowblockApp = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const authUser = useSelector((s) => s.auth.user);
  const { configured, selectedOrder, orderDetailLoading } = useSelector((s) => s.yellowblock);
  const [activeView, setActiveView] = useState('orders');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const kitchenOnly = authUser?.role === 'kitchen';

  const userName = authUser
    ? [authUser.profile?.firstName, authUser.profile?.lastName].filter(Boolean).join(' ') || authUser.email
    : '';
  const pageName = NAV_ITEMS.find(item => item.key === activeView)?.label;

  useEffect(() => {
    if (authUser && !kitchenOnly) dispatch(fetchYellowblockConfigStatus());
  }, [authUser, dispatch, kitchenOnly]);

  const handleViewDetail = useCallback(
    (orderId) => {
      dispatch(fetchYellowblockOrderDetail(orderId));
    },
    [dispatch]
  );

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  if (kitchenOnly) return <Navigate to={KITCHEN_PATH} replace />;

  return (
    <div className="yb-workspace" onKeyDown={event => { if (event.key === 'Escape') setSidebarOpen(false); }}>
      {sidebarOpen && <button type="button" aria-label="Close navigation" className="yb-nav-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside id="yellowblock-navigation" className={`yb-sidebar ${sidebarOpen ? 'yb-sidebar-open' : ''}`}>
        <div className="yb-sidebar-brand">
          <img src="/images/yellow-block-logo.png.png" alt="Yellow Block" />
          <button type="button" aria-label="Close menu" className="yb-icon-button yb-mobile-menu" onClick={() => setSidebarOpen(false)}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Yellow Block workspace">
          {NAV_ITEMS.map(({ key, label, icon: Icon }, index) => (
            <React.Fragment key={key}>
              {index === 0 && <p className="yb-nav-group">Operations</p>}
              {key === 'products' && <p className="yb-nav-group">Catalog &amp; events</p>}
              <button
                type="button"
                aria-current={activeView === key ? 'page' : undefined}
                onClick={() => {
                  if (key === 'kitchen') navigate(KITCHEN_PATH);
                  else if (activeView !== key) {
                    setActiveView(key);
                    window.scrollTo(0, 0);
                  }
                  setSidebarOpen(false);
                }}
                className="yb-nav-item"
              >
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
                {activeView === key && <ChevronRight size={14} aria-hidden="true" className="yb-nav-arrow" />}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="yb-sidebar-account">
          <span className="yb-avatar" aria-hidden="true">{userName.charAt(0).toUpperCase() || 'U'}</span>
          <span className="truncate text-sm font-semibold">{userName}</span>
          <button type="button" aria-label="Sign out" title="Sign out" onClick={handleLogout} className="yb-icon-button yb-signout">
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div className="yb-workspace-body">
        <header className="yb-topbar">
          <button type="button" aria-label="Open navigation" aria-controls="yellowblock-navigation" aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)} className="yb-icon-button yb-mobile-menu">
            <Menu size={22} aria-hidden="true" />
          </button>
          <img className="yb-mobile-logo" src="/images/yellow-block-logo.png.png" alt="Yellow Block" />
          <div className="yb-breadcrumb"><span>Workspace</span><ChevronRight size={13} aria-hidden="true" /><span>{pageName}</span></div>
        </header>

        <main className={`yb-main yb-view-${activeView}`}>
          {activeView === 'invoices' ? (
            <YellowblockInvoiceGenerator />
          ) : configured === false ? (
            <NotConfigured />
          ) : configured === null ? (
            <div className="flex items-center justify-center flex-1"><Spinner /></div>
          ) : (
            activeView === 'orders' ? <YellowblockDeliveryCalendar onViewOrder={handleViewDetail} allowAssignment /> : (
              <div className="yb-secondary-view mx-auto w-full max-w-7xl">
                {activeView === 'products' && <ProductsView />}
                {activeView === 'asset_management' && <AssetManagementView />}
                {activeView === 'third_party_delivery' && <ThirdPartyDeliveryView onViewOrder={handleViewDetail} />}
                {activeView === 'events' && <Events />}
              </div>
            )
          )}
        </main>
      </div>

      {/* ── Order Detail Modal ── */}
      {(selectedOrder || orderDetailLoading) && (
        <div>
          {orderDetailLoading ? (
            <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <OrderDetailModal
              order={selectedOrder}
              onClose={() => dispatch(clearSelectedOrder())}
              allowAssignment={activeView === 'orders'}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default YellowblockApp;
