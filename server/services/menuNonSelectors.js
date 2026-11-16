import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';
import MenuSelectionArchive from '../models/MenuSelectionArchive.js';
import matter from './matterApiService.js';
import { excludeRecreatedArchivedAliases } from './archivedMenuAliases.js';
import { businessDateKeyOf, isDateKey } from '../utils/businessDate.js';

const key = value => String(value ?? '').trim();
const emailKey = value => key(value).toLowerCase();
const failure = message => Object.assign(new Error(message), { statusCode: 409 });

export function customersWithoutMenuSelections(deliveries, records, startDate, endDate) {
  const customers = new Map(), emailOwners = new Map(), subscriptionOwners = new Map();
  for (const row of deliveries) {
    const date = key(row.delivery_date).slice(0, 10);
    if (!isDateKey(date) || date < startDate || date > endDate) continue;
    const id = key(row.customer_id);
    if (!id) throw failure('Matter returned a delivery without a customer ID. Retry before using this list.');
    if (!customers.has(id)) customers.set(id, { customerId: id, name: key(row.name), email: emailKey(row.email), phone: key(row.phone), deliveryDates: new Set() });
    customers.get(id).deliveryDates.add(date);
    const email = emailKey(row.email), subscription = key(row.subscription_id);
    if (email) emailOwners.set(email, new Set([...(emailOwners.get(email) || []), id]));
    if (subscription) subscriptionOwners.set(subscription, new Set([...(subscriptionOwners.get(subscription) || []), id]));
  }
  const selected = new Set();
  for (const record of records) {
    const hasChoice = (record.selectedMeals || []).some(meal => {
      const date = businessDateKeyOf(meal.date);
      return !meal.isAutoAssigned && Number(meal.quantity ?? 1) > 0 && date && date >= startDate && date <= endDate;
    });
    if (!hasChoice) continue;
    // Permanent IDs cannot be overridden by another person's matching email.
    if (key(record.matterCustomerId)) { selected.add(key(record.matterCustomerId)); continue; }
    const exact = subscriptionOwners.get(key(record.matterSubscriptionId));
    const owners = exact?.size ? exact : emailOwners.get(emailKey(record.matterEmail || record.email));
    if (owners?.size > 1) throw failure('A saved selection matches more than one Matter customer. Resolve the customer identity before using this list.');
    if (owners?.size === 1) selected.add([...owners][0]);
  }
  return [...customers.values()].filter(customer => !selected.has(customer.customerId))
    .map(customer => ({ ...customer, deliveryDates: [...customer.deliveryDates].sort() }))
    .sort((a, b) => (a.name || a.email || a.customerId).localeCompare(b.name || b.email || b.customerId));
}

export async function getMenuNonSelectors(menuId) {
  const menu = await WeeklyMenu.findById(menuId).select('title startDate endDate').lean();
  if (!menu) throw Object.assign(new Error('Menu not found.'), { statusCode: 404 });
  const startDate = businessDateKeyOf(menu.startDate), endDate = businessDateKeyOf(menu.endDate);
  if (!startDate || !endDate || startDate > endDate) throw failure('This menu has an invalid date range.');
  // One live range check, not seven daily sweeps. Upstream rejects incomplete
  // rosters so an unavailable Matter response never becomes an empty result.
  const deliveries = await matter.findSubscriptionsWithDeliveryInRange(startDate, endDate);
  if (!Array.isArray(deliveries)) throw failure('Matter delivery availability could not be verified. Retry.');
  // Read selections AFTER the potentially long Matter lookup so choices made
  // while it was running are reflected in the result. No auto-assignment/writes.
  const records = await MenuSelectionRecord.find({ weeklyMenuId: menuId })
    .select('weeklyMenuId email matterEmail matterCustomerId matterSubscriptionId selectedMeals skippedDays dayNotes').lean();
  const aliases = records.filter(record => !record.matterCustomerId).map(record => record.email);
  const archives = aliases.length ? await MenuSelectionArchive.find({ 'original.weeklyMenuId': menu._id, 'original.email': { $in: aliases } }).lean() : [];
  const customers = customersWithoutMenuSelections(deliveries, excludeRecreatedArchivedAliases(records, archives), startDate, endDate);
  return { menuId: String(menu._id), menuTitle: menu.title, startDate, endDate, checkedAt: new Date().toISOString(), customers };
}
