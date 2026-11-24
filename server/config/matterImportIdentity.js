// Server-owned identities: subscription obligation plus the importer's existing
// one-stop-per-customer/day rule, including renewals and internal relinking.
export const MATTER_IMPORT_IDENTITIES = [
  ['matterImportKey', 'matter_import_obligation_unique'],
  ['matterImportCustomerKey', 'matter_import_customer_day_unique'],
  ['matterImportSourceCustomerKey', 'matter_import_source_customer_day_unique']
];

export function matterImportIdentityKeys(snapshot, date) {
  const customerId = String(snapshot.customerId || '').trim();
  if (!customerId) throw new Error('A matched internal customer ID is required before importing a delivery.');
  const keys = {
    matterImportKey: `${date}:${String(snapshot.matterSubscriptionId)}`,
    matterImportCustomerKey: `${date}:${customerId}`
  };
  const permanent = String(snapshot.matterCustomerId ?? '').trim();
  if (permanent) keys.matterImportSourceCustomerKey = `${date}:${permanent}`;
  return keys;
}
