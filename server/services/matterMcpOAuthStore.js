import McpOAuthRecord from '../models/McpOAuthRecord.js';

export function createMcpOAuthStore(model = McpOAuthRecord) {
  const alive = () => ({ expiresAt: { $gt: new Date() } });
  return {
    async put(kind, key, payload, expiresAt) {
      await model.create({ kind, key, payload, expiresAt });
    },
    async get(kind, key) {
      const record = await model.findOne({ kind, key, ...(kind === 'client' ? {} : alive()) }).lean();
      return record?.payload;
    },
    async take(kind, key) {
      const record = await model.findOneAndDelete({ kind, key, ...alive() }).lean();
      return record?.payload;
    },
    async findGrant(field, hash) {
      const match = field === 'refreshHash'
        ? { $or: [{ 'payload.refreshHash': hash }, { 'payload.usedRefreshHashes': hash }] }
        : { [`payload.${field}`]: hash };
      return model.findOne({ kind: 'grant', ...match, ...alive() }).lean();
    },
    async rotate(key, previousHash, payload, expiresAt) {
      return model.findOneAndUpdate({ kind: 'grant', key, 'payload.refreshHash': previousHash, ...alive() },
        { $set: { payload, expiresAt } }, { new: true }).lean();
    },
    async revoke(clientId, hash) {
      await model.deleteMany({ kind: 'grant', 'payload.clientId': clientId,
        $or: [{ 'payload.accessHash': hash }, { 'payload.refreshHash': hash }] });
    },
    async revokeGrant(key) { await model.deleteMany({ kind: 'grant', key }); },
  };
}
