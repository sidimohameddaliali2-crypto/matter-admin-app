import React from 'react';
import { ChevronDown } from 'lucide-react';
import { matterDateLabel } from '../utils/customerMatterMetadata';
import { formatMoney } from '../utils/subscriptionFormat';

const valueLabel = value => value == null || value === '' ? 'Not provided' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
const dateLabel = value => typeof value === 'string' ? matterDateLabel(value.slice(0, 10)) : 'Not provided';
const timestampLabel = value => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' }) : 'Not provided';

function Field({ label, value }) {
  return <div className="min-w-0"><dt className="text-xs text-gray-500">{label}</dt><dd className="mt-1 text-sm font-medium text-matter-navy break-words">{valueLabel(value)}</dd></div>;
}

function Group({ title, children }) {
  return <section aria-label={title} className="min-w-0 rounded-xl border border-gray-200 p-4">
    <h3 className="text-sm font-semibold text-matter-navy mb-3">{title}</h3>{children}
  </section>;
}

function FoodLabels({ items, allergen = false }) {
  if (!Array.isArray(items)) return <p className="text-sm text-gray-500">Not provided by Matter</p>;
  const names = items.map(item => allergen ? item?.name : item?.title).filter(name => typeof name === 'string' && name.trim());
  if (!names.length) return <p className="text-sm text-gray-500">{allergen ? 'No allergens listed' : 'No exclusions listed'}</p>;
  return <div className="flex flex-wrap gap-1.5">{names.map((name, index) => <span key={`${name}-${index}`}
    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${allergen ? 'bg-red-600 text-white' : 'bg-matter-dust/40 text-matter-charcoal'}`}>{name}</span>)}</div>;
}

// Read only the nested Matter response. Scheduled IDs may return 404 when
// requested directly; current-plan and internal customer values are not defaults.
export default function UpcomingPlanSection({ subscription }) {
  const plan = subscription?.upcoming_plan;
  const available = plan && typeof plan === 'object' && !Array.isArray(plan);
  const supplied = Object.prototype.hasOwnProperty.call(subscription || {}, 'upcoming_plan');
  const core = String(plan?.plan?.name || '').trim().toLowerCase() === 'matter core';
  const rhythm = typeof plan?.delivery_rhythm === 'string' ? plan.delivery_rhythm : plan?.delivery_rhythm?.label ?? plan?.delivery_rhythm?.name;
  const dateList = dates => Array.isArray(dates) ? (dates.length ? dates.map(dateLabel).join(', ') : 'None listed') : 'Not provided';
  return <details key={`${subscription?.subscription_id}-${plan?.subscription_id || 'none'}`} aria-label="Upcoming plan" className="group bg-white rounded-2xl border border-matter-dust/40 shadow-md mb-4">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matter-sky [&::-webkit-details-marker]:hidden">
      <span className="min-w-0">
        <span className="block font-serif-mgmt text-xl font-bold text-matter-navy">Upcoming</span>
        <span className="block mt-1 text-sm text-gray-600">{available
          ? `${plan.plan?.name || 'Plan name not provided'} · Starts ${dateLabel(plan.starting_date)}`
          : supplied ? 'No upcoming plan scheduled' : 'Upcoming plan not provided by Matter'}</span>
      </span>
      <ChevronDown aria-hidden="true" className="w-5 h-5 shrink-0 text-gray-500 transition-transform group-open:rotate-180" />
    </summary>
    <div className="border-t border-gray-100 p-4 sm:p-5">
      {!available ? <p className="text-sm text-gray-500">{supplied ? 'Matter has not supplied an upcoming plan for this customer.' : 'Upcoming plan information is unavailable in the Matter response.'}</p> : <>
        <div className="rounded-xl bg-blue-50 p-4 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Start date · Dubai</p>
          <p className="text-xl font-bold text-matter-navy mt-1">{dateLabel(plan.starting_date)}</p>
          <p className="text-sm text-gray-600 mt-1">Subscription {valueLabel(plan.subscription_id)} · {valueLabel(plan.subscription_status)}</p>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Group title="Upcoming subscription">
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Plan" value={plan.plan?.name} /><Field label="Status" value={plan.subscription_status} />
              <Field label="Replaces subscription" value={plan.replaces_subscription_id} /><Field label="Cycle start" value={dateLabel(plan.cycle_start_date)} />
              <Field label="Cycle end" value={dateLabel(plan.cycle_end_date)} /><Field label="Next delivery" value={dateLabel(plan.next_delivery_date)} />
              <Field label="Meals per day" value={plan.plan?.meal_frequency} /><Field label="Snacks per day" value={plan.snacks_per_day} />
              <Field label="Breakfast included" value={plan.breakfast_included} /><Field label="Total meals" value={plan.total_meals} />
              <Field label="Total deliveries" value={plan.total_deliveries} /><Field label="Remaining deliveries" value={plan.remaining_deliveries} />
              <Field label="Total food days" value={plan.total_food_days} /><Field label="Delivery rhythm" value={rhythm} />
              <Field label="Double delivery" value={plan.has_double_delivery} /><Field label="Delivery window" value={plan.delivery_window?.label} />
              <Field label="Delivery timezone" value={plan.delivery_window?.timezone} /><Field label="Renewal due" value={dateLabel(plan.renewal_due_date)} />
            </dl>
          </Group>
          <div className="space-y-4 min-w-0">
            <Group title="Upcoming nutrition">
              <dl className="grid grid-cols-2 gap-4">
                <Field label="Calories (kcal)" value={plan.total_calories} />
                <Field label={core ? 'Protein portion (g)' : 'Protein (g)'} value={plan.macros?.protein} />
                <Field label={core ? 'Carbohydrate portion (g)' : 'Carbohydrates (g)'} value={plan.macros?.carbohydrates} />
                <Field label="Fat (g)" value={plan.macros?.fat} />
              </dl>
              {core && <p className="text-xs text-gray-500 mt-3">Matter Core portions are food weights.</p>}
            </Group>
            <Group title="Upcoming allergens"><FoodLabels items={plan.allergens} allergen /></Group>
            <Group title="Upcoming exclusions"><FoodLabels items={plan.exclusions} /></Group>
          </div>
          <Group title="Upcoming delivery addresses">
            {!Array.isArray(plan.customer_addresses) ? <p className="text-sm text-gray-500">Addresses not provided by Matter.</p>
              : !plan.customer_addresses.length ? <p className="text-sm text-gray-500">No addresses supplied for the upcoming plan.</p>
                : <div className="space-y-3">{plan.customer_addresses.map((address, index) => <div key={address.id ?? index} className="rounded-lg bg-gray-50 p-3">
                  <p className="text-sm font-semibold text-matter-navy mb-2">{address.label || `Address ${index + 1}`}</p>
                  <dl className="grid grid-cols-2 gap-3">
                    <Field label="Category" value={address.category} /><Field label="Status" value={address.status} />
                    <Field label="Current delivery address" value={address.current_delivery_address} /><Field label="Address type" value={address.type} />
                    <Field label="Delivery zone" value={address.area} /><Field label="Emirate" value={address.emirate} />
                    <Field label="Street" value={address.street} /><Field label="Building" value={address.building} />
                    <Field label="Unit / villa number" value={address.unit} /><Field label="Floor" value={address.floor} />
                    <Field label="Latitude" value={address.coordinates?.lat} /><Field label="Longitude" value={address.coordinates?.lng} />
                    <Field label="Additional details" value={address.additional_details} />
                  </dl>
                </div>)}</div>}
          </Group>
          <Group title="Upcoming pricing">
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Base price" value={formatMoney(plan.base_price, plan.currency)} />
              <Field label="Bag price" value={formatMoney(plan.bag_price, plan.currency)} />
              <Field label="Discount" value={formatMoney(plan.discount?.amount, plan.currency)} />
              <Field label="Discount code" value={plan.discount?.code} />
              <Field label="VAT (%)" value={plan.vat_percentage} /><Field label="VAT" value={formatMoney(plan.vat, plan.currency)} />
              <Field label="Gross paid" value={formatMoney(plan.gross_paid, plan.currency)} /><Field label="Currency" value={plan.currency} />
            </dl>
          </Group>
        </div>
        <div className="mt-4"><Group title="Upcoming delivery schedule">
          {!Array.isArray(plan.delivery_schedule) ? <p className="text-sm text-gray-500">Schedule not provided by Matter.</p>
            : !plan.delivery_schedule.length ? <p className="text-sm text-gray-500">No deliveries listed.</p>
              : <div className="max-h-72 overflow-auto" tabIndex={0} aria-label="Upcoming delivery schedule table"><table className="w-full text-sm text-left">
                <thead><tr className="text-xs text-gray-500"><th scope="col" className="p-2">Date</th><th scope="col" className="p-2">Status</th><th scope="col" className="p-2">Food days</th><th scope="col" className="p-2">Double delivery</th></tr></thead>
                <tbody>{plan.delivery_schedule.map((entry, index) => <tr key={`${entry.date}-${index}`} className="border-t border-gray-100">
                  <td className="p-2 whitespace-nowrap">{dateLabel(entry.date)}</td><td className="p-2">{valueLabel(entry.status)}</td><td className="p-2">{valueLabel(entry.food_days)}</td><td className="p-2">{valueLabel(entry.is_double)}</td>
                </tr>)}</tbody>
              </table></div>}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4"><Field label="Paused dates" value={dateList(plan.pauses?.paused_days)} /><Field label="Resumed dates" value={dateList(plan.pauses?.resumed_days)} /></dl>
        </Group></div>
        <div className="mt-4"><Group title="Upcoming payments">
          {!Array.isArray(plan.payments) ? <p className="text-sm text-gray-500">Payments not provided by Matter.</p>
            : !plan.payments.length ? <p className="text-sm text-gray-500">No payments listed.</p>
              : <div className="overflow-x-auto" tabIndex={0} aria-label="Upcoming payments table"><table className="w-full text-sm text-left">
                <thead><tr className="text-xs text-gray-500"><th scope="col" className="p-2">Reference</th><th scope="col" className="p-2">Date</th><th scope="col" className="p-2">Amount</th><th scope="col" className="p-2">Status</th><th scope="col" className="p-2">Method</th></tr></thead>
                <tbody>{plan.payments.map((payment, index) => <tr key={payment.id ?? index} className="border-t border-gray-100">
                  <td className="p-2">{valueLabel(payment.transaction_id)}</td><td className="p-2 whitespace-nowrap">{dateLabel(payment.date)}</td><td className="p-2 whitespace-nowrap">{formatMoney(payment.amount, payment.currency ?? plan.currency)}</td><td className="p-2">{valueLabel(payment.status)}</td><td className="p-2">{valueLabel(payment.method)}</td>
                </tr>)}</tbody>
              </table></div>}
        </Group></div>
        <p className="text-xs text-gray-500 mt-4">Upcoming plan updated: {timestampLabel(plan.updated_at)} (Dubai)</p>
      </>}
    </div>
  </details>;
}
