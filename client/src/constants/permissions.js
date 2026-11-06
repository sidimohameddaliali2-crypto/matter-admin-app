// Canonical page-permission model for the app.
//
// MUST stay in sync with server/models/User.js (PERMISSION_KEYS,
// ROLE_DEFAULT_KEYS, getDefaultPermissions). Every navigable page has exactly
// one key here; the sidebar (Layout.js), the route guards (App.js) and the
// permissions editor (UserPermissionsModal.js) all key off this list.

export const PERMISSION_GROUPS = [
  {
    label: 'Overview',
    items: [
      { key: 'dashboard', label: 'Dashboard', description: 'Dashboard and overview statistics' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { key: 'deliveries', label: 'Deliveries', description: 'Create, view, and manage deliveries' },
      { key: 'drivers', label: 'Drivers', description: 'Driver accounts and performance' },
      { key: 'fleet', label: 'Fleet', description: 'Vehicles, assignments, and fleet status' },
      { key: 'delivery_changes', label: 'Delivery Changes', description: 'Delivery change requests' },
      { key: 'bags', label: 'Bag Tracking', description: 'Bag inventory and assignments' },
      { key: 'reports', label: 'Reports', description: 'Reports and analytics' },
      { key: 'events', label: 'Events', description: 'Create and manage events' },
      { key: 'complaints', label: 'Complaints', description: 'Customer complaints' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { key: 'customers', label: 'Customers', description: 'Customer records and delivery history' },
      { key: 'customer_service', label: 'Customer service', description: 'Service workspace entry; explicit service membership controls review and supervision' },
      { key: 'website_subscriptions', label: 'Customer Management', description: 'Matter website subscriptions' },
      { key: 'subscription', label: 'Subscription & Sales', description: 'Subscription and sales dashboard' },
      { key: 'customer_analytics', label: 'Customer Analytics', description: 'Customer analytics reports' },
      { key: 'renewal', label: 'Renewal', description: 'Subscription renewals' },
    ],
  },
  {
    label: 'Kitchen & Menus',
    items: [
      { key: 'menus', label: 'Menus', description: 'Weekly menus and meal planning' },
      { key: 'kitchen_list', label: 'Kitchen List', description: 'Kitchen preparation lists' },
      { key: 'kitchen_counting', label: 'Kitchen Counting', description: 'Meal cook-counts and prep weights, exportable to Excel' },
      { key: 'matter_core', label: 'Matter Core', description: 'Matter Core documents' },
    ],
  },
  {
    label: 'Partners',
    items: [
      { key: 'partners', label: 'Partners', description: 'Partner management' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { key: 'users', label: 'Users', description: 'Manage users and their permissions' },
      { key: 'employees', label: 'Employees', description: 'Employee records' },
    ],
  },
];

// Page keys, in display order.
export const PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

// Legacy / non-page keys the server still stores. Not shown in the editor.
export const LEGACY_PERMISSION_KEYS = ['late_deliveries', 'live_map', 'settings', 'yellowblock'];

const ALL_KEYS = [...PERMISSION_KEYS, ...LEGACY_PERMISSION_KEYS];

// Which keys default to ON for each role. Keep identical to the server.
const ROLE_DEFAULT_KEYS = {
  super_admin: ALL_KEYS,
  admin: [
    'dashboard', 'deliveries', 'drivers', 'fleet', 'delivery_changes', 'bags', 'reports', 'events', 'complaints',
    'customers', 'website_subscriptions', 'subscription', 'customer_analytics', 'renewal',
    'menus', 'kitchen_list', 'kitchen_counting', 'matter_core', 'partners', 'users', 'employees',
    'late_deliveries', 'live_map',
  ],
  manager: [
    'dashboard', 'deliveries', 'bags', 'reports', 'customers',
    'website_subscriptions', 'subscription', 'customer_analytics', 'renewal', 'employees',
    'late_deliveries', 'live_map',
  ],
  dispatcher: [
    'dashboard', 'deliveries', 'bags', 'events', 'complaints', 'customers',
    'late_deliveries', 'live_map',
  ],
  driver: ['dashboard', 'deliveries'],
  viewer: ['dashboard', 'reports'],
  store_keeper: ['bags'],
  yellowblock_user: ['events', 'yellowblock'],
  kitchen: ['kitchen_list', 'kitchen_counting', 'partners'],
};

export const getDefaultPermissions = (role) => {
  const on = new Set(ROLE_DEFAULT_KEYS[role] || []);
  const out = {};
  ALL_KEYS.forEach((key) => { out[key] = on.has(key); });
  return out;
};
