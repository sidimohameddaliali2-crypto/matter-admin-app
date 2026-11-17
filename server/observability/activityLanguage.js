// Activity language is deliberately a closed vocabulary. Request bodies may
// select a known operation, but names, notes, IDs and credentials never enter it.
const areas = [
  ['customer-service-capture', 'Conversation capture', 'conversation capture'],
  ['customer-service', 'Customer Service', 'Customer Service'],
  ['drivers', 'Drivers', 'driver records'],
  ['auth', 'Staff sign-in', 'staff sign-in'],
  ['users', 'Staff accounts', 'staff accounts'],
  ['deliveries', 'Deliveries', 'deliveries'],
  ['delivery-changes', 'Delivery changes', 'delivery changes'],
  ['bags', 'Bags', 'bag records'],
  ['bag-operations', 'Bag operations', 'bag operations'],
  ['bag-refunds', 'Bag refunds', 'bag refund records'],
  ['bag-followups', 'Bag follow-ups', 'bag follow-ups'],
  ['bag-notes', 'Bag notes', 'bag notes'],
  ['store-keeper-scans', 'Warehouse scans', 'warehouse scans'],
  ['reports', 'Reports', 'reports'],
  ['alerts', 'Operational alerts', 'operational alerts'],
  ['events', 'Event deliveries', 'event deliveries'],
  ['handoffs', 'Driver handoffs', 'driver handoff records'],
  ['communications', 'Communication records', 'communication records'],
  ['incidents', 'Incidents', 'incident records'],
  ['delivery-issues', 'Delivery issues', 'delivery issue records'],
  ['menus', 'Menus and kitchen', 'menus and kitchen records'],
  ['meal-creation', 'Meal library', 'the meal library'],
  ['matter-core', 'Matter Core meals', 'Matter Core meal records'],
  ['customers', 'Customers', 'customer records'],
  ['matter', 'Matter subscriptions', 'Matter subscription records'],
  ['admin/partners', 'Partner administration', 'partner administration'],
  ['partner/auth', 'Partner sign-in', 'partner sign-in'],
  ['partner', 'Partner portal', 'the partner portal'],
  ['member/auth', 'Member sign-in', 'member sign-in'],
  ['member', 'Member portal', 'the member portal'],
  ['webhooks', 'Incoming customer events', 'incoming customer events'],
  ['employees', 'Employees and leave', 'employee and leave records'],
  ['truckoom', 'Vehicle trackers', 'vehicle tracker records'],
  ['vehicles', 'Vehicles', 'vehicle records'],
  ['upload', 'Photos and uploads', 'photos and uploads'],
  ['xero', 'Accounting', 'accounting requests'],
  ['yellowblock', 'Yellowblock orders and assets', 'Yellowblock orders and assets'],
  ['external/deliveries', 'External delivery access', 'external delivery information'],
  ['external/drivers', 'External driver access', 'external driver information'],
  ['mcp', 'Assistant access', 'assistant access'],
  ['mobile', 'Driver app updates', 'driver app updates'],
  ['traceability', 'Activity history', 'activity history'],
  ['driver-audits', 'Driver reports', 'driver reports'],
  ['reporting', 'Driver reports', 'driver reports'],
  ['session', 'Report sign-in', 'report sign-in'],
  ['health', 'App availability', 'app availability'],
  ['test', 'App diagnostics', 'app diagnostics'],
];

const change = (action, submission, saved, intent = `${action}.`, operationKind = 'change') => ({
  action,
  accepted: `submitted ${submission}`,
  saved,
  intent,
  operationKind,
});
const request = (action, noun, intent, operationKind = 'calculation') => ({
  action,
  accepted: `requested ${noun}`,
  saved: `requested ${noun}`,
  intent,
  operationKind,
});
const rules = [];
function rule(methods, template, description) {
  const escaped = template
    .split('/')
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  // Specific operation rules are declared after the general record rules.
  rules.unshift({
    methods: methods.split('|'),
    pattern: new RegExp(`^${escaped}$`),
    ...description,
  });
}
function resource(path, noun) {
  rule('POST', path, change(`Add a ${noun}`, `a new ${noun}`, `added a ${noun}`));
  rule(
    'PUT|PATCH',
    `${path}/:id`,
    change(`Update a ${noun}`, `changes to a ${noun}`, `updated a ${noun}`),
  );
  rule(
    'DELETE',
    `${path}/:id`,
    change(`Delete a ${noun}`, `a request to delete a ${noun}`, `deleted a ${noun}`),
  );
}

for (const suffix of ['', '/partner', '/member']) {
  rule(
    'POST',
    '/api/traceability/capture' + suffix,
    request(
      'Record form activity',
      'a form activity record',
      'Record an observed form edit or submission, separately from saved business changes.',
      'integration',
    ),
  );
}

resource('/api/drivers', 'driver');
resource('/api/users', 'staff account');
resource('/api/deliveries', 'delivery');
resource('/api/events', 'event delivery');
resource('/api/menus', 'menu');
resource('/api/customers', 'customer');
resource('/api/incidents', 'incident');
resource('/api/vehicles', 'vehicle');
resource('/api/admin/partners', 'partner');
resource('/api/yellowblock/assets', 'asset');

rule(
  'PUT',
  '/api/drivers/:id/location',
  change(
    'Record a driver position',
    'a driver position',
    'recorded a driver position',
    'Record a device position; its fix time and receipt time are separate.',
  ),
);
rule(
  'PATCH',
  '/api/drivers/:id/status',
  change(
    'Change driver availability',
    'a driver availability change',
    'changed driver availability',
  ),
);
rule(
  'POST',
  '/api/drivers/:id/route-directions',
  request(
    'Calculate driver directions',
    'driver directions',
    'Calculate directions without assigning or changing deliveries.',
  ),
);
rule(
  'POST',
  '/api/drivers/returns',
  request(
    'Report a bag return',
    'a bag return acknowledgement',
    'Acknowledge a bag return report; this action does not save a bag return record.',
    'integration',
  ),
);
rule(
  'PUT',
  '/api/users/me/dashboard-layout',
  change('Save a dashboard layout', 'a dashboard layout', 'saved a dashboard layout'),
);
rule(
  'POST',
  '/api/auth/register',
  change('Register a staff account', 'a staff registration', 'registered a staff account'),
);
rule(
  'POST',
  '/api/auth/login',
  request(
    'Sign in to the staff app',
    'staff sign-in',
    'Authenticate a staff account.',
    'authentication',
  ),
);
rule(
  'PUT',
  '/api/auth/profile',
  change('Update a staff profile', 'staff profile changes', 'updated a staff profile'),
);
rule(
  'PUT',
  '/api/auth/change-password',
  change('Change a staff password', 'a staff password change', 'changed a staff password'),
);
rule(
  'POST',
  '/api/auth/push-token',
  change(
    'Enable device notifications',
    'a device notification registration',
    'registered a device for notifications',
    'Register a device; notification delivery is a separate event.',
  ),
);
rule(
  'DELETE',
  '/api/auth/push-token',
  change(
    'Disable device notifications',
    'a device notification removal',
    'removed a device notification registration',
  ),
);

rule(
  'PUT',
  '/api/deliveries/delivery-order',
  change('Reorder delivery stops', 'a delivery stop order', 'saved the delivery stop order'),
);
rule(
  'POST',
  '/api/deliveries/resolve-coords',
  request(
    'Find saved delivery pins',
    'saved delivery pins',
    'Look up existing pins without guessing or saving a new entrance.',
  ),
);
rule(
  'POST',
  '/api/deliveries/geocode-google',
  request(
    'Look up delivery pins with Google',
    'a delivery pin lookup',
    'Look up a map result without saving a pin; saving a pin and verifying an entrance are separate actions.',
  ),
);
rule(
  'POST',
  '/api/deliveries/route-eta',
  request(
    'Estimate delivery arrival times',
    'delivery arrival estimates',
    'Calculate estimated arrival times without confirming actual arrivals.',
  ),
);
rule(
  'POST',
  '/api/deliveries/optimize-routes',
  request(
    'Preview a route plan',
    'a draft route plan',
    'Calculate a draft route plan; applying assignments is a separate action.',
  ),
);
rule(
  'POST',
  '/api/deliveries/optimize-routes/apply',
  change(
    'Apply a route plan',
    'a route plan for application',
    'saved route assignments and handoff plans',
    'Save route assignments and proposed handoffs; this does not establish that drivers completed them.',
  ),
);
rule(
  'POST',
  '/api/deliveries/bulk',
  change('Add multiple deliveries', 'new deliveries', 'added deliveries'),
);
rule(
  'PATCH',
  '/api/deliveries/assign-driver',
  change('Assign deliveries to a driver', 'a driver assignment', 'assigned deliveries to a driver'),
);
rule(
  'PATCH',
  '/api/deliveries/unassign-driver',
  change(
    'Remove delivery assignments',
    'a request to remove delivery assignments',
    'removed delivery assignments',
  ),
);
rule(
  'POST',
  '/api/deliveries/:id/start',
  change('Record a delivery start', 'a delivery start', 'recorded a delivery start'),
);
rule(
  'POST',
  '/api/deliveries/:id/collect',
  change(
    'Record a bag collection',
    'a bag collection report',
    'recorded a bag collection report',
    'Record the submitted collection status and evidence; physical custody needs its own evidence.',
  ),
);
rule(
  'POST',
  '/api/deliveries/:id/complete',
  change(
    'Record a delivery completion',
    'a delivery completion report',
    'recorded a delivery completion',
    'Record the submitted completion status; physical handover needs its own evidence.',
  ),
);
rule(
  'POST',
  '/api/deliveries/return-bag',
  change('Record a returned bag', 'a bag return report', 'recorded a bag return report'),
);
rule(
  'PATCH',
  '/api/deliveries/:id/acknowledge-change',
  change(
    'Acknowledge a delivery change',
    'a delivery change acknowledgement',
    'acknowledged a delivery change',
  ),
);
rule(
  'PATCH',
  '/api/deliveries/:id/bag-assignment',
  change(
    'Assign a bag to a delivery',
    'a delivery bag assignment',
    'saved a delivery bag assignment',
  ),
);
rule(
  'PATCH',
  '/api/deliveries/:id/status',
  change(
    'Update a delivery status',
    'a delivery status report',
    'recorded a delivery status update',
    'Record the submitted status; it does not independently verify physical handover.',
  ),
);
for (const path of ['by-ids', 'bulk-delete'])
  rule(
    'DELETE',
    `/api/deliveries/${path}`,
    change('Delete deliveries', 'a request to delete deliveries', 'deleted deliveries'),
  );
rule(
  'POST',
  '/api/deliveries/:id/report-issue',
  change(
    'Report a delivery issue',
    'a delivery issue report',
    'recorded a delivery issue report',
    'Save an issue report; resolving it is a separate action.',
  ),
);
rule(
  'POST',
  '/api/deliveries/:id/assignment-suggestions',
  request(
    'Preview delivery assignment suggestions',
    'delivery assignment suggestions',
    'Calculate suggestions without changing the assignment.',
  ),
);
rule(
  'POST',
  '/api/deliveries/:id/manual-coords',
  change(
    'Save a delivery map pin',
    'a delivery map pin',
    'saved a delivery map pin',
    'Save the chosen pin without independently verifying an entrance.',
  ),
);

rule(
  'POST',
  '/api/delivery-changes/manual',
  change(
    'Add a delivery change',
    'a new delivery change',
    'recorded a delivery change',
    'Record a pending delivery change; applying it is a separate action.',
  ),
);
for (const path of ['/api/delivery-changes/:id/apply', '/api/delivery-changes/apply/:changeId'])
  rule(
    'POST',
    path,
    change(
      'Apply a delivery change',
      'a delivery change for application',
      'recorded the application of a delivery change',
    ),
  );
rule(
  'POST',
  '/api/delivery-changes/upload',
  change(
    'Import delivery changes',
    'a delivery change import',
    'recorded imported delivery changes',
    'Import change records; pending changes require a separate application step.',
  ),
);
rule(
  'POST',
  '/api/delivery-changes/test-post',
  request(
    'Check the delivery change form',
    'a delivery change form check',
    'Check the form connection without saving or applying a delivery change.',
    'integration',
  ),
);
rule(
  'PUT',
  '/api/events/options/:company',
  change('Save event delivery options', 'event delivery options', 'saved event delivery options'),
);
rule(
  'POST',
  '/api/events/:id/assign-driver',
  change(
    'Assign an event delivery',
    'an event delivery assignment',
    'saved an event delivery assignment',
  ),
);
rule(
  'PATCH',
  '/api/handoffs/:id/status',
  change(
    'Update a driver handoff status',
    'a driver handoff status',
    'recorded a driver handoff status',
    'Record the submitted handoff status and keep physical transfer evidence separate.',
  ),
);
rule(
  'POST',
  '/api/alerts/flagged-customer',
  request(
    'Request a customer alert',
    'a customer alert notification',
    'Request a staff notification; disabled notifications can be acknowledged without sending a message.',
    'integration',
  ),
);
rule(
  'POST',
  '/api/communications',
  change(
    'Add a communication record',
    'a communication record',
    'added a communication record',
    'Save a staff communication record without claiming a message was delivered.',
  ),
);
rule(
  'PUT',
  '/api/communications/:id',
  change(
    'Update a communication record',
    'communication record changes',
    'updated a communication record',
  ),
);
rule(
  'DELETE',
  '/api/communications/:id',
  change(
    'Delete a communication record',
    'a request to delete a communication record',
    'deleted a communication record',
  ),
);
rule(
  'POST',
  '/api/delivery-issues',
  change('Add a delivery issue', 'a delivery issue', 'recorded a delivery issue'),
);
rule(
  'PATCH',
  '/api/delivery-issues/:id',
  change('Update a delivery issue', 'delivery issue changes', 'updated a delivery issue'),
);

rule(
  'PATCH',
  '/api/bags/:id/update-flag',
  change('Change a bag flag', 'a bag flag change', 'changed a bag flag'),
);
rule(
  'POST',
  '/api/bag-operations/register',
  change('Register a bag', 'a bag registration', 'registered a bag'),
);
rule(
  'POST',
  '/api/bag-operations/movements',
  change(
    'Record a bag movement',
    'a bag movement report',
    'recorded a bag movement',
    'Record the submitted custody movement with its domain event; a scan alone is not a completed transfer.',
  ),
);
rule(
  'PUT',
  '/api/bag-operations/reviews',
  change(
    'Update a bag review',
    'a bag review update',
    'saved a bag review',
    'Save review work without changing stock or custody.',
  ),
);
rule(
  'POST',
  '/api/bag-operations/stock-counts',
  change(
    'Record a bag stock count',
    'a bag stock count',
    'recorded a bag stock count',
    'Save the submitted count without overwriting inventory.',
  ),
);
rule(
  'POST',
  '/api/bag-refunds',
  change(
    'Open a bag refund review',
    'a bag refund review',
    'recorded a bag refund review',
    'Save an internal refund review; payment provider evidence is separate.',
  ),
);
rule(
  'POST',
  '/api/bag-refunds/:id/actions',
  change(
    'Update a bag refund review',
    'a bag refund review update',
    'updated a bag refund review',
    'Save an internal refund record; payment provider evidence is separate.',
  ),
);
rule(
  'POST',
  '/api/bag-followups',
  change(
    'Save a bag follow-up',
    'a bag follow-up',
    'saved a bag follow-up',
    'Save an internal reminder; this does not send a message to the customer.',
  ),
);
rule(
  'POST',
  '/api/store-keeper-scans',
  change(
    'Record a warehouse scan',
    'a warehouse scan',
    'recorded a warehouse scan',
    'Save a scan; physical transfer and custody updates are separate records.',
  ),
);
rule('POST', '/api/bag-notes', change('Add a bag note', 'a bag note', 'added a bag note'));
rule(
  'DELETE',
  '/api/bag-notes/:id',
  change('Delete a bag note', 'a request to delete a bag note', 'deleted a bag note'),
);
rule(
  'POST',
  '/api/upload/delivery-photo',
  change(
    'Upload a delivery photo',
    'a delivery photo upload',
    'uploaded a delivery photo',
    'Save a photo; linking it to a delivery and verifying handover are separate.',
  ),
);
rule(
  'POST',
  '/api/upload/bag-tag-logo',
  change('Upload a bag label logo', 'a bag label logo upload', 'uploaded a bag label logo'),
);

rule(
  'POST',
  '/api/menus/:id/kitchen-customers/:customerId/meal-editor',
  change('Edit a kitchen meal', 'a kitchen meal edit', 'saved a kitchen meal edit'),
);
rule(
  'POST',
  '/api/menus/customers/:customerId/meal-profile',
  change(
    'Save a customer meal profile',
    'a customer meal profile',
    'saved a customer meal profile',
  ),
);
for (const path of ['kitchen-breakfast-presets', ':id/breakfast-presets'])
  rule(
    'PUT',
    `/api/menus/${path}`,
    change('Save breakfast presets', 'breakfast presets', 'saved breakfast presets'),
  );
rule(
  'PUT|PATCH',
  '/api/menus/kitchen-snack-presets',
  change('Save snack presets', 'snack presets', 'saved snack presets'),
);
for (const [path, label] of [
  ['snack-options', 'snack options'],
  ['breakfast-options', 'breakfast options'],
  ['main-meal-options', 'main meal options'],
  ['matter-core-meal-options', 'Matter Core meal options'],
]) {
  rule('PUT', `/api/menus/:id/${path}`, change(`Save ${label}`, label, `saved ${label}`));
}
for (const [path, label] of [
  ['assign-snacks', 'snack assignments'],
  ['assign-matter-core-meals', 'Matter Core meal assignments'],
  ['assign-main-meals', 'main meal assignments'],
  ['partner-meals', 'partner meal assignments'],
]) {
  rule('POST', `/api/menus/:id/${path}`, change(`Save ${label}`, label, `saved ${label}`));
}
rule(
  'POST',
  '/api/menus/:id/kitchen-state',
  change('Save kitchen planning', 'kitchen planning changes', 'saved kitchen planning changes'),
);
rule(
  'POST',
  '/api/menus/:id/kitchen-upload',
  change(
    'Import kitchen selections',
    'a kitchen selection import',
    'recorded imported kitchen selections',
  ),
);
rule(
  'POST',
  '/api/menus/:id/auto-populate-missing',
  change(
    'Fill missing meal selections',
    'a request to fill missing meal selections',
    'recorded generated meal selections',
  ),
);
rule('POST', '/api/menus/items', change('Add a menu item', 'a new menu item', 'added a menu item'));
rule(
  'POST',
  '/api/menus/customers/:email/skip-pause-preview',
  request(
    'Preview meal skips and pauses',
    'a meal skip and pause preview',
    'Preview the effect of meal changes without saving selections or subscription pauses.',
  ),
);
rule(
  'POST',
  '/api/menus/customers/:email/select-meals',
  change('Save meal selections', 'meal selections', 'saved meal selections'),
);
rule(
  'PUT',
  '/api/menus/:menuId/selections/:email',
  change('Update meal selections', 'meal selection changes', 'updated meal selections'),
);
rule(
  'DELETE',
  '/api/menus/:menuId/selections/:email',
  change(
    'Remove meal selections',
    'a request to remove meal selections',
    'removed meal selections',
  ),
);
for (const [path, label] of [
  ['macros-presets', 'meal nutrition presets'],
  ['day-notes', 'meal day notes'],
  ['meal-remarks', 'meal remarks'],
])
  rule(
    'PATCH',
    `/api/menus/:menuId/selections/:email/${path}`,
    change(`Save ${label}`, label, `saved ${label}`),
  );
rule(
  'POST',
  '/api/meal-creation/bootstrap',
  change(
    'Initialize the meal library',
    'meal library initialization',
    'recorded meal library initialization',
    'Create or recover the shared meal library; existing data may already satisfy this request.',
  ),
);
rule(
  'PUT',
  '/api/meal-creation',
  change('Save the meal library', 'meal library changes', 'saved the meal library'),
);
rule(
  'POST',
  '/api/matter-core/upload',
  change(
    'Import Matter Core meals',
    'a Matter Core meal import',
    'recorded imported Matter Core meals',
  ),
);

for (const [path, label] of [
  ['upload-emails', 'customer emails'],
  ['upload-bulk', 'customer records'],
  ['upload-macros', 'customer nutrition targets'],
])
  rule(
    'POST',
    `/api/customers/${path}`,
    change(`Import ${label}`, `an import of ${label}`, `recorded imported ${label}`),
  );
rule(
  'PATCH',
  '/api/customers/:oldCustomerId/rename-id',
  change(
    'Change a customer reference',
    'a customer reference change',
    'changed a customer reference',
  ),
);
rule(
  'POST',
  '/api/customers/send-whatsapp-reminder',
  request(
    'Request a customer reminder',
    'a customer WhatsApp reminder',
    'Request a provider message; customer receipt needs separate delivery evidence.',
    'integration',
  ),
);
rule(
  'POST',
  '/api/customers/match/link',
  change(
    'Link a customer subscription',
    'a customer subscription link',
    'saved a customer subscription link',
  ),
);
rule(
  'POST',
  '/api/customers/match/unlink',
  change(
    'Remove a customer subscription link',
    'a request to remove a customer subscription link',
    'removed a customer subscription link',
  ),
);
rule(
  'POST',
  '/api/customers/match/bulk',
  change(
    'Match customer subscriptions',
    'customer subscription matches',
    'recorded customer subscription matches',
  ),
);

for (const portal of ['partner', 'member']) {
  rule(
    'POST',
    `/api/${portal}/auth/register`,
    change(
      `Register a ${portal} account`,
      `a ${portal} registration`,
      `registered a ${portal} account`,
    ),
  );
  rule(
    'POST',
    `/api/${portal}/auth/login`,
    request(
      `Sign in to the ${portal} portal`,
      `${portal} sign-in`,
      `Authenticate a ${portal} account.`,
      'authentication',
    ),
  );
  rule(
    'PATCH',
    `/api/${portal}/profile`,
    change(
      `Update a ${portal} profile`,
      `${portal} profile changes`,
      `updated a ${portal} profile`,
    ),
  );
  rule(
    'POST',
    `/api/${portal}/orders`,
    change(
      `Create a ${portal} order draft`,
      `a ${portal} order draft`,
      `saved a ${portal} order draft`,
      'Save a draft order; submission and fulfilment are separate stages.',
    ),
  );
  rule(
    'POST',
    `/api/${portal}/orders/:id/submit`,
    change(
      `Submit a ${portal} order`,
      `a ${portal} order`,
      `recorded a ${portal} order submission`,
      'Record the order submission; fulfilment remains separate.',
    ),
  );
  rule(
    'POST',
    `/api/${portal}/orders/:id/cancel`,
    change(
      `Cancel a ${portal} order`,
      `a ${portal} order cancellation`,
      `recorded a ${portal} order cancellation`,
    ),
  );
  rule(
    'DELETE',
    `/api/${portal}/orders/:id`,
    change(
      `Delete a ${portal} order draft`,
      `a request to delete a ${portal} order draft`,
      `deleted a ${portal} order draft`,
    ),
  );
}
rule(
  'POST',
  '/api/partner/members/invite-token',
  change(
    'Create a member invitation',
    'a member invitation',
    'created a member invitation',
    'Create an invitation; registration is a separate action.',
  ),
);
for (const path of ['/api/partner/waste', '/api/admin/partners/waste'])
  rule(
    'POST',
    path,
    change('Record partner food waste', 'partner food waste', 'recorded partner food waste'),
  );
rule(
  'POST',
  '/api/admin/partners/menu',
  change('Add a partner menu item', 'a partner menu item', 'added a partner menu item'),
);
rule(
  'PATCH',
  '/api/admin/partners/menu/:itemId',
  change('Update a partner menu item', 'partner menu item changes', 'updated a partner menu item'),
);
rule(
  'DELETE',
  '/api/admin/partners/menu/:itemId',
  change(
    'Delete a partner menu item',
    'a request to delete a partner menu item',
    'deleted a partner menu item',
  ),
);
rule(
  'POST',
  '/api/admin/partners/costs',
  change('Record partner meal costs', 'partner meal costs', 'recorded partner meal costs'),
);
rule(
  'PATCH',
  '/api/admin/partners/prices',
  change('Update partner meal prices', 'partner meal price changes', 'updated partner meal prices'),
);
rule(
  'PATCH',
  '/api/admin/partners/orders/:orderId/status',
  change(
    'Update a partner order status',
    'a partner order status',
    'recorded a partner order status',
  ),
);
rule(
  'PATCH',
  '/api/admin/partners/orders/:orderId/lock',
  change(
    'Change a partner order lock',
    'a partner order lock change',
    'changed a partner order lock',
  ),
);
rule(
  'POST',
  '/api/admin/partners/upload-picture',
  change(
    'Upload a partner menu picture',
    'a partner menu picture',
    'uploaded a partner menu picture',
  ),
);
rule(
  'POST',
  '/api/admin/partners/:id/menu',
  change(
    'Assign a partner menu item',
    'a partner menu assignment',
    'saved a partner menu assignment',
  ),
);
rule(
  'DELETE',
  '/api/admin/partners/:id/menu/:menuItemId',
  change(
    'Remove a partner menu item',
    'a request to remove a partner menu assignment',
    'removed a partner menu assignment',
  ),
);
rule(
  'PATCH',
  '/api/admin/partners/:id/members/:memberId',
  change('Update a partner member', 'partner member changes', 'updated a partner member'),
);

rule('POST', '/api/employees', change('Add an employee', 'a new employee', 'added an employee'));
rule(
  'PUT',
  '/api/employees/:id',
  change('Update an employee', 'employee record changes', 'updated an employee'),
);
rule(
  'POST',
  '/api/employees/:id/leave-requests',
  change(
    'Request employee leave',
    'an employee leave request',
    'recorded an employee leave request',
  ),
);
for (const [decision, label] of [
  ['approve', 'Approve'],
  ['reject', 'Reject'],
])
  rule(
    'PUT',
    `/api/employees/leave-requests/:requestId/${decision}`,
    change(
      `${label} a leave request`,
      `a leave request decision`,
      `recorded a leave request ${decision === 'approve' ? 'approval' : 'rejection'}`,
    ),
  );
rule(
  'DELETE',
  '/api/employees/leave-requests/:requestId',
  change(
    'Delete a leave request',
    'a request to delete a leave request',
    'deleted a leave request',
  ),
);
rule(
  'POST',
  '/api/matter/sales-dashboard/refresh',
  change(
    'Refresh subscription sales information',
    'a subscription sales refresh',
    'recorded refreshed subscription sales information',
  ),
);
rule(
  'POST',
  '/api/matter/standardize-deliveries',
  change(
    'Refresh delivery names and time windows',
    'delivery name and time window updates',
    'recorded refreshed delivery names and time windows',
  ),
);
rule(
  'POST',
  '/api/matter/import-deliveries',
  change(
    'Import Matter deliveries',
    'a Matter delivery import',
    'recorded imported Matter deliveries',
  ),
);
rule(
  'POST',
  '/api/matter/subscriptions/:id/pauses',
  change(
    'Record a subscription pause',
    'a subscription pause request',
    'recorded a subscription pause',
    'Record the subscription pause response; effective delivery changes require separate evidence.',
  ),
);
rule(
  'PUT',
  '/api/truckoom/vehicles/:vehicleNo/driver',
  change(
    'Link a tracker vehicle to a driver',
    'a tracker vehicle and driver link',
    'saved a tracker vehicle and driver link',
    'Save the current mapping without inferring historical assignments.',
  ),
);
rule(
  'POST',
  '/api/vehicles/:id/fuel-logs',
  change('Record vehicle fuel', 'a vehicle fuel record', 'recorded vehicle fuel'),
);
rule(
  'DELETE',
  '/api/vehicles/:id/fuel-logs/:logId',
  change('Delete a fuel record', 'a request to delete a fuel record', 'deleted a fuel record'),
);
rule(
  'POST',
  '/api/xero/invoices/from-subscription/:subscriptionId',
  request(
    'Request an accounting invoice',
    'an accounting invoice',
    'Request an invoice from the accounting provider; creation, payment and reconciliation require provider evidence.',
    'integration',
  ),
);
rule(
  'POST',
  '/api/yellowblock/assets/bulk',
  change('Add multiple assets', 'new assets', 'added assets'),
);
rule(
  'POST',
  '/api/yellowblock/third-party-companies',
  change(
    'Add an external delivery company',
    'an external delivery company',
    'added an external delivery company',
  ),
);
rule(
  'POST',
  '/api/yellowblock/third-party-assignments',
  change(
    'Assign an external delivery company',
    'an external delivery assignment',
    'recorded an external delivery assignment',
  ),
);
rule(
  'POST',
  '/api/webhooks/customer-event',
  change(
    'Receive a customer event',
    'an incoming customer event',
    'recorded an incoming customer event',
    'Save event receipt; applying a subscription or delivery change is separate.',
    'integration',
  ),
);
rule(
  'POST|ALL',
  '/api/mcp',
  request(
    'Request an assistant operation',
    'an assistant operation',
    'An assistant request may contain multiple operations; their individual results need separate evidence.',
    'integration',
  ),
);
rule(
  'POST',
  '/api/mcp/oauth/consent',
  request(
    'Authorize assistant access',
    'assistant access authorization',
    'Record consent for assistant access.',
    'authentication',
  ),
);

const serviceCommands = new Map([
  ['create', change('Add a customer issue', 'a new customer issue', 'recorded a customer issue')],
  [
    'work',
    change(
      'Update a customer issue',
      'work on a customer issue',
      'recorded work on a customer issue',
    ),
  ],
  [
    'assign',
    change('Assign a customer issue', 'a customer issue assignment', 'assigned a customer issue'),
  ],
  [
    'request_transfer',
    change(
      'Request an issue reassignment',
      'an issue reassignment request',
      'recorded an issue reassignment request',
    ),
  ],
  [
    'classify',
    change(
      'Classify a customer issue',
      'a customer issue classification',
      'classified a customer issue',
    ),
  ],
  [
    'classify_suggestion',
    change(
      'Review an issue classification suggestion',
      'an issue classification decision',
      'recorded an issue classification decision',
    ),
  ],
  [
    'progress',
    change('Record issue progress', 'customer issue progress', 'recorded customer issue progress'),
  ],
  [
    'followup',
    change(
      'Add an issue follow-up',
      'a customer issue follow-up',
      'added a customer issue follow-up',
    ),
  ],
  [
    'followup_update',
    change(
      'Update an issue follow-up',
      'customer issue follow-up changes',
      'updated a customer issue follow-up',
    ),
  ],
  [
    'exception',
    change(
      'Request a policy exception',
      'a policy exception request',
      'recorded a policy exception request',
    ),
  ],
  [
    'approve_exception',
    change(
      'Record a policy exception decision',
      'a policy exception decision',
      'recorded a policy exception decision',
    ),
  ],
  [
    'resolve',
    change(
      'Record an issue resolution',
      'a customer issue resolution',
      'recorded a customer issue resolution',
      'Record a resolution against the issue; chat closure and real-world remedy evidence are separate.',
    ),
  ],
  [
    'split',
    change(
      'Separate a customer issue',
      'a separate customer issue',
      'recorded a separate customer issue',
    ),
  ],
  [
    'link_message',
    change(
      'Link evidence to a customer issue',
      'customer issue evidence links',
      'linked evidence to a customer issue',
    ),
  ],
  [
    'acknowledge',
    change(
      'Acknowledge an issue alert',
      'an issue alert acknowledgement',
      'acknowledged an issue alert',
    ),
  ],
  [
    'read',
    change(
      'Mark a customer issue as read',
      'a customer issue read acknowledgement',
      'marked a customer issue as read',
    ),
  ],
  [
    'feedback',
    change('Record customer feedback', 'customer feedback', 'recorded customer feedback'),
  ],
]);
const serviceDefault = change(
  'Update a customer issue',
  'a customer issue update',
  'recorded a customer issue update',
);
rule('POST', '/api/customer-service/requests', serviceCommands.get('create'));
rule('POST', '/api/customer-service/work-items', serviceCommands.get('work'));
rule('POST', '/api/customer-service/requests/:id/commands', serviceDefault);
for (const [methods, path, action, submission, saved] of [
  [
    'PUT',
    'team',
    'Configure Customer Service staff',
    'Customer Service staff configuration',
    'saved Customer Service staff configuration',
  ],
  [
    'POST',
    'setup',
    'Set up Customer Service access',
    'Customer Service access configuration',
    'saved Customer Service access configuration',
  ],
  [
    'PUT',
    'request-calendar',
    'Save Customer Service working hours',
    'Customer Service working hours',
    'saved Customer Service working hours',
  ],
  [
    'PUT',
    'request-rules',
    'Save Customer Service rules',
    'Customer Service rules',
    'saved Customer Service rules',
  ],
  [
    'PUT',
    'request-grants',
    'Save Customer Service permissions',
    'Customer Service permissions',
    'saved Customer Service permissions',
  ],
  [
    'POST',
    'reviews/next',
    'Claim a conversation review',
    'a conversation review claim',
    'recorded a conversation review claim',
  ],
  [
    'PUT',
    'reviews/:id/draft',
    'Save a conversation review draft',
    'a conversation review draft',
    'saved a conversation review draft',
  ],
  [
    'POST',
    'reviews/:id/submit',
    'Submit a conversation review',
    'a conversation review',
    'recorded a conversation review submission',
  ],
  [
    'POST',
    'reviews/:id/skip',
    'Skip a conversation review',
    'a request to skip a conversation review',
    'recorded a skipped conversation review',
  ],
  [
    'POST',
    'reviews/:id/reassign',
    'Reassign a conversation review',
    'a conversation review reassignment',
    'reassigned a conversation review',
  ],
  [
    'POST',
    'reviews/:id/corrections',
    'Request a review correction',
    'a review correction request',
    'recorded a review correction request',
  ],
  [
    'POST',
    'reviews/:id/corrections/:index/resolve',
    'Record a review correction decision',
    'a review correction decision',
    'recorded a review correction decision',
  ],
  [
    'POST',
    'reviews/:id/calibration',
    'Request a second conversation review',
    'a second conversation review request',
    'recorded a second conversation review request',
  ],
  [
    'POST',
    'issues/:id/episodes',
    'Add an issue episode',
    'an issue episode',
    'recorded an issue episode',
  ],
  [
    'POST',
    'issues/:id/actions',
    'Add an issue action',
    'an issue action',
    'recorded an issue action',
  ],
  [
    'PATCH',
    'actions/:id',
    'Update an issue action',
    'issue action changes',
    'updated an issue action',
  ],
  [
    'POST',
    'allocate',
    'Allocate conversation reviews',
    'conversation review allocations',
    'recorded conversation review allocations',
  ],
  [
    'POST',
    'import',
    'Import Customer Service history',
    'a Customer Service history import',
    'recorded imported Customer Service history',
  ],
  [
    'POST',
    'contacts/:id/link',
    'Update a contact customer link',
    'a contact customer link change',
    'saved a contact customer link change',
  ],
])
  rule(methods, `/api/customer-service/${path}`, change(action, submission, saved));
rule(
  'POST',
  '/api/customer-service/gallabox/check',
  request(
    'Check the WhatsApp inbox connection',
    'a WhatsApp inbox connection check',
    'Check provider availability without changing a customer conversation.',
    'integration',
  ),
);
rule(
  'POST',
  '/api/customer-service/gallabox/capture',
  change(
    'Capture WhatsApp conversation history',
    'a WhatsApp conversation capture',
    'recorded captured WhatsApp conversation history',
    'Import source history; completeness and customer contact require separate evidence.',
    'integration',
  ),
);

const refundCommands = new Map([
  [
    'inspect',
    change(
      'Record a returned bag inspection',
      'a returned bag inspection',
      'recorded a returned bag inspection',
    ),
  ],
  [
    'approve',
    change(
      'Approve a bag refund record',
      'a bag refund approval',
      'recorded a bag refund approval',
    ),
  ],
  [
    'reopen',
    change(
      'Reopen a bag refund review',
      'a bag refund review reopening',
      'reopened a bag refund review',
    ),
  ],
  [
    'complete',
    change(
      'Record a bag refund completion',
      'a bag refund completion report',
      'recorded a bag refund as completed',
      'Record staff confirmation in the app; money movement requires separate payment provider evidence.',
    ),
  ],
  [
    'not_due',
    change(
      'Mark a bag refund as not due',
      'a decision that a bag refund is not due',
      'recorded a bag refund as not due',
    ),
  ],
  [
    'add_returns',
    change(
      'Add returned bags to a refund review',
      'returned bags for a refund review',
      'added returned bags to a refund review',
    ),
  ],
]);

const bagMovements = new Map([
  [
    'observe_warehouse',
    change(
      'Record a warehouse bag observation',
      'a warehouse bag observation',
      'recorded a warehouse bag observation',
    ),
  ],
  [
    'pack',
    change(
      'Prepare a bag handoff',
      'a prepared bag handoff',
      'recorded a prepared bag handoff',
      'Record preparation; acceptance by the receiving driver is a separate action.',
    ),
  ],
  [
    'accept',
    change(
      'Record a driver accepting a bag',
      'a driver bag acceptance',
      'recorded a driver bag acceptance',
    ),
  ],
  [
    'cancel_handover',
    change(
      'Cancel a prepared bag handoff',
      'a bag handoff cancellation',
      'recorded a bag handoff cancellation',
    ),
  ],
  [
    'deliver',
    change('Record a bag delivery', 'a bag delivery report', 'recorded a bag delivery report'),
  ],
  [
    'collect',
    change(
      'Record a bag pickup',
      'a bag pickup report',
      'recorded a bag pickup report',
      'Record a driver pickup; warehouse receipt is a separate action.',
    ),
  ],
  [
    'receive',
    change(
      'Record a warehouse bag receipt',
      'a warehouse bag receipt',
      'recorded a warehouse bag receipt',
    ),
  ],
  [
    'start_cleaning',
    change('Record bag cleaning starting', 'a bag cleaning start', 'recorded a bag cleaning start'),
  ],
  [
    'release',
    change(
      'Release an inspected bag to stock',
      'an inspected bag release',
      'recorded an inspected bag release',
    ),
  ],
  [
    'quarantine',
    change(
      'Record bag damage and quarantine',
      'a bag damage and quarantine report',
      'recorded bag damage and quarantine',
    ),
  ],
  [
    'repair',
    change(
      'Record a bag repair inspection',
      'a bag repair inspection',
      'recorded a bag repair inspection',
    ),
  ],
  ['retire', change('Retire a bag', 'a bag retirement', 'recorded a bag retirement')],
  [
    'offer_transfer',
    change(
      'Offer a bag transfer',
      'a bag transfer offer',
      'recorded a bag transfer offer',
      'Record an offer; acceptance by the receiving driver is a separate action.',
    ),
  ],
  [
    'accept_transfer',
    change(
      'Record acceptance of a bag transfer',
      'a bag transfer acceptance',
      'recorded a bag transfer acceptance',
    ),
  ],
]);
const contactLinks = new Map([
  [
    'link',
    change(
      'Link a contact to a customer',
      'a contact customer link',
      'linked a contact to a customer',
    ),
  ],
  [
    'unlink',
    change(
      'Remove a contact customer link',
      'a request to remove a contact customer link',
      'removed a contact customer link',
    ),
  ],
  [
    'revert',
    change(
      'Restore the source contact customer link',
      'a request to restore a source contact customer link',
      'restored the source contact customer link',
    ),
  ],
]);

const readTopics = [
  [/\/locations(?:\/history)?$|\/drivers\/[^/]+\/location$/, 'driver positions'],
  [/\/stats(?:\/(?:weekly|monthly))?$|\/stats\/overview$/, 'driver and staff statistics'],
  [/\/delivery-order$/, 'the delivery stop order'],
  [/\/depot$/, 'the delivery depot'],
  [/\/(?:timing-history|timing-records|late-early)$/, 'delivery timing records'],
  [/\/(?:monthly-count|daily-customer-counts)$/, 'delivery counts'],
  [/\/driver\/today$/, 'today’s assigned deliveries'],
  [/\/complaints\/all$/, 'delivery issue reports'],
  [/\/(?:export\.xlsx|export\/[^/]+)$/, 'a report export'],
  [/\/kitchen-list$/, 'the kitchen production list'],
  [/\/kitchen-state$/, 'kitchen planning'],
  [/\/kitchen-dates$/, 'kitchen production dates'],
  [/\/kitchen-partner-orders$/, 'partner kitchen orders'],
  [/\/meal-log$/, 'kitchen meal edit history'],
  [/\/meal-editor$/, 'the kitchen meal editor'],
  [/\/(?:complete-profile|meal-profile|subscription-profile)$/, 'a customer meal profile'],
  [/\/share-link$/, 'a menu selection link'],
  [/\/share\/[^/]+$/, 'a shared meal selection'],
  [/\/did-not-select$/, 'customers without meal selections'],
  [/\/selections$/, 'meal selections'],
  [/\/supy-recipes\/search$/, 'recipe search results'],
  [/\/conversations(?:\/[^/]+)?$/, 'captured customer conversations'],
  [/\/media$/, 'a captured message attachment'],
  [/\/capture-health$|\/gallabox\/sync$/, 'conversation capture health'],
  [/\/customer-link$|\/contacts\/[^/]+\/link$/, 'a contact customer link'],
  [/\/context$/, 'customer context'],
  [/\/requests\/[^/]+\/insights$/, 'customer issue insights'],
  [/\/request-report$/, 'the customer issue report'],
  [/\/request-calendar$/, 'Customer Service working hours'],
  [/\/(?:request-follow-ups|follow-ups)$/, 'customer issue follow-ups'],
  [/\/reviews$/, 'conversation reviews'],
  [/\/request(?:s)?\/definitions$|\/issue-options$/, 'customer issue action options'],
  [/\/requests(?:\/[^/]+)?$|\/issues(?:\/[^/]+)?$/, 'customer issue records'],
  [/\/team$|\/owners$/, 'Customer Service staff'],
  [/\/policy$|\/categories$/, 'Customer Service policy and topics'],
  [/\/metrics$|\/summary$/, 'Customer Service reporting'],
  [/\/sales-dashboard$/, 'subscription sales information'],
  [/\/subscriptions\/[^/]+\/pauses$/, 'subscription pause records'],
  [/\/subscriptions\/[^/]+\/delivery-comparison$/, 'subscription delivery comparisons'],
  [
    /\/subscriptions\/kitchen-inputs$|\/nutrition-by-(?:email|subscription-id)$/,
    'subscription nutrition information',
  ],
  [/\/subscriptions\/financials$/, 'subscription financial information'],
  [/\/subscriptions\/analytics$/, 'subscription analytics'],
  [/\/subscriptions\/active-contacts$/, 'active subscription contacts'],
  [/\/leave-requests$/, 'employee leave requests'],
  [/\/fuel-logs$/, 'vehicle fuel records'],
  [/\/usage-logs$|\/assets-usage-stats$/, 'asset usage records'],
  [/\/orders(?:\/[^/]+)?$/, 'order records'],
  [/\/invoices(?:\/[^/]+)?$/, 'invoice records'],
  [/\/waste(?:\/all)?$/, 'food waste records'],
];

function issueFor(statusCode, outcome) {
  if (outcome === 'disconnected' || statusCode === 0)
    return 'The connection ended before the result was confirmed.';
  if (statusCode === 401) return 'Sign-in was required, so the request was rejected.';
  if (statusCode === 403) return 'Permission was denied, so the request was rejected.';
  if (statusCode === 404) return 'The requested record or page was not found.';
  if (statusCode === 409)
    return 'The request conflicted with the current record. Refresh before retrying.';
  if (statusCode === 429) return 'Too many requests were made. Try again shortly.';
  if (statusCode >= 500)
    return 'The server could not complete the request. The result has not been confirmed.';
  if (statusCode >= 400 || outcome === 'rejected')
    return 'The request was rejected. Check the required fields and try again.';
  if (['failed', 'server_error'].includes(outcome))
    return 'The operation reported a failure. The result has not been confirmed.';
  if (outcome === 'partial')
    return 'Only part of the operation completed. Review the result before retrying.';
  if (outcome === 'degraded')
    return 'The result is incomplete or using a fallback. Review it before relying on it.';
  return null;
}

/**
 * Describe a source-declared route or a local request path. `actorName` must come
 * from verified identity. Only `outcome: 'saved'` confirms persistence; an HTTP
 * success, including the tracing outcome 'completed', only confirms acceptance.
 */
export function describeActivity({
  method = 'GET',
  path = '',
  body,
  statusCode,
  actorName,
  outcome,
} = {}) {
  const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';
  const pathname = (typeof path === 'string' ? path : '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .replace(/^\/api\/users\/drivers(?=\/|$)/, '/api/drivers');
  const family = areas.find(
    ([prefix]) => pathname === `/api/${prefix}` || pathname.startsWith(`/api/${prefix}/`),
  );
  const [, area = 'App', context = 'the app'] = family || [];
  let description = rules.find(
    (entry) => entry.methods.includes(verb) && entry.pattern.test(pathname),
  );
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (verb === 'POST' && /^\/api\/customer-service\/requests\/[^/]+\/commands$/.test(pathname)) {
    // An unknown explicit operation cannot borrow a known free-text action.
    const operation = Object.hasOwn(input, 'operation') ? input.operation : input.action;
    description = serviceCommands.get(operation) || serviceDefault;
  }
  if (verb === 'POST' && /^\/api\/bag-refunds\/[^/]+\/actions$/.test(pathname)) {
    description = refundCommands.get(input.action) || description;
  }
  if (verb === 'POST' && pathname === '/api/bag-operations/movements') {
    description = bagMovements.get(input.action) || description;
  }
  if (verb === 'POST' && /^\/api\/customer-service\/contacts\/[^/]+\/link$/.test(pathname)) {
    description = contactLinks.get(input.operation) || description;
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(verb)) {
    const topic =
      readTopics.find(([pattern]) => pattern.test(pathname))?.[1] ||
      (family ? context : 'app information');
    description = {
      action: `View ${topic}`,
      accepted: `requested ${topic}`,
      saved: `requested ${topic}`,
      intent: `Read ${topic}; this request does not by itself confirm a change.`,
      operationKind: 'read',
    };
  }
  description ||= change(
    `Submit a change in ${context}`,
    `a change in ${context}`,
    `recorded a change in ${context}`,
    `Submit a change in ${context}; the specific operation has not been identified.`,
  );
  const actor =
    typeof actorName === 'string' && actorName.trim()
      ? actorName
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .trim()
          .slice(0, 120)
      : 'An unidentified actor';
  const issue = issueFor(statusCode, outcome);
  let sentence = outcome === 'saved' ? description.saved : description.accepted;
  if (issue) {
    const rejected = (statusCode >= 400 && statusCode < 500) || outcome === 'rejected';
    sentence = `tried to ${description.action[0].toLowerCase()}${description.action.slice(1)}, but ${rejected ? 'the request was rejected' : 'the result was not confirmed'}`;
  }
  return {
    area,
    action: description.action,
    summary: `${actor} ${sentence}.`,
    issue,
    intent: description.intent,
    operationKind: description.operationKind,
  };
}
