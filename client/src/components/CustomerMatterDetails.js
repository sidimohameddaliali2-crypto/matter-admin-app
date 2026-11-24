import React from 'react';
import { customerMatterMetadata, customerType, hasUpcomingPlan, matterDateLabel, typeLabel } from '../utils/customerMatterMetadata';

export function CustomerTypeTag({ customer }) {
  const type = customerType(customer);
  if (!type) return null;
  return <span aria-label="Customer type" className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 whitespace-nowrap">{typeLabel(type)}</span>;
}

export function CustomerTagBadges({ customer }) {
  const tags = customerMatterMetadata(customer)?.customer_tags;
  if (!Array.isArray(tags) || !tags.length) return null;
  return <span aria-label="Customer tags" className="inline-flex flex-wrap items-center gap-1.5">
    {tags.map((tag, index) => {
      const color = /^#[a-f\d]{6}$/i.test(tag.color) ? tag.color : '#3B82F6';
      return <span key={`${tag.id}-${index}`} className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold text-matter-navy"
        style={{ backgroundColor: `${color}20`, borderColor: `${color}55` }}>{tag.name}</span>;
    })}
  </span>;
}

export default function CustomerMatterDetails({ customer, compact = false }) {
  const metadata = customerMatterMetadata(customer);
  const upcoming = hasUpcomingPlan(customer);
  const plan = metadata?.upcoming_plan;
  const timestamp = value => new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' });
  return <section aria-label="Matter customer details" className={compact ? 'mb-3' : 'bg-white rounded-lg border border-gray-200 p-6'}>
    {!compact && <h2 className="text-lg font-semibold text-gray-900 mb-3">Matter customer details</h2>}
    <div className="flex flex-wrap items-center gap-2">
      {upcoming && <span className="rounded-full bg-indigo-100 text-indigo-800 px-3 py-1 text-xs font-semibold">Upcoming plan</span>}
      {compact && <CustomerTypeTag customer={customer} />}
      {compact && <CustomerTagBadges customer={customer} />}
    </div>
    {!compact && <>
      {upcoming && <p className="text-sm text-indigo-800 mt-2">{plan.plan?.name || 'Plan name not provided'} · Starts {matterDateLabel(plan.starting_date)} · Subscription {plan.subscription_id}</p>}
      {!upcoming && <p className="text-sm text-gray-600 mt-2">Upcoming plan: {metadata && Object.prototype.hasOwnProperty.call(metadata, 'upcoming_plan') ? 'None scheduled for today or later' : 'Not provided by Matter'}</p>}
      {metadata?.updated_at && <p className="text-xs text-gray-500 mt-3">Matter updated: {timestamp(metadata.updated_at)} (Dubai)</p>}
      {metadata?.fetchedAt && <p className="text-xs text-gray-500">Captured: {timestamp(metadata.fetchedAt)} (Dubai)</p>}
      {!metadata && <p className="text-xs text-gray-500 mt-3">Matter details unavailable. A saved Matter customer or subscription link is required.</p>}
    </>}
  </section>;
}
