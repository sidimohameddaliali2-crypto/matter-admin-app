import mongoose from 'mongoose';

export const isEmailDerivedCustomerId = (id, email) => {
  const value = String(id || '').trim().toLowerCase();
  const address = String(email || '').trim().toLowerCase();
  if (!value || !address.includes('@')) return false;
  return [address, address.split('@')[0], address.replace(/[^a-z0-9]/g, '_')].includes(value);
};

// One Mongo document serializes allocation across processes. $max never lowers
// an existing reservation, including reservations whose later create failed.
export async function nextCustomerId({ session, customers, counters } = {}) {
  customers ||= mongoose.connection.collection('customers');
  counters ||= mongoose.connection.collection('customeridcounters');
  const options = session ? { session } : {};
  for (let attempt = 0; attempt < 5; attempt++) {
    const [highest] = await customers.aggregate([
      { $match: { customerId: { $regex: '^CUST-[0-9]+$', $options: 'i' } } },
      { $project: { number: { $convert: { input: { $substrCP: ['$customerId', 5, { $subtract: [{ $strLenCP: '$customerId' }, 5] }] }, to: 'long', onError: null, onNull: null } } } },
      { $group: { _id: null, value: { $max: '$number' } } },
    ], options).toArray();
    const floor = Number(highest?.value || 0);
    if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('Customer number sequence is outside the supported range.');
    try {
      await counters.updateOne({ _id: 'customer' }, { $max: { value: floor } }, { ...options, upsert: true });
    } catch (error) {
      if (error.code === 11000 && !session) continue;
      throw error;
    }
    const result = await counters.findOneAndUpdate({ _id: 'customer' }, { $inc: { value: 1 } }, { ...options, returnDocument: 'after' });
    const counter = result?.value && typeof result.value === 'object' ? result.value : result;
    const number = Number(counter?.value);
    if (!Number.isSafeInteger(number) || number <= floor) throw new Error('Customer number could not be reserved.');
    const customerId = `CUST-${String(number).padStart(9, '0')}`;
    if (!await customers.findOne({ customerId }, { ...options, projection: { _id: 1 } })) return customerId;
  }
  throw new Error('Customer ID allocation is busy. Retry creation.');
}
