import {createHash} from 'node:crypto';
export const preservationHash = value => createHash('sha256').update(value).digest('hex');
export function verifyPreservedRow(expected,row) {
 if(!row || row.kind!==expected.kind || row.id!==expected.id || row.sha256!==expected.sha256 || preservationHash(row.payload)!==expected.sha256) throw Error('Exact baseline record unavailable or corrupt');
 return row;
}
export function relationshipReport(records) {
 const ids=new Map(), missing=[];for(const r of records){let set=ids.get(r.kind);if(!set)ids.set(r.kind,set=new Set());set.add(r.id);}
 const refs={conversationId:'serviceconversations',issueId:'serviceissues',reviewId:'servicereviews'};
 for(const r of records){for(const [field,kind] of Object.entries(refs)){const value=r.body?.[field];if(typeof value==='string'&&value&&!ids.get(kind)?.has(value))missing.push({kind:r.kind,id:r.id,field,targetKind:kind,targetId:value});}}
 return {records:records.length,missingReferences:missing.length,missing};
}

export function manifestPageSql(table){if(!['inbox_record','inbox_record_history'].includes(table))throw Error('Invalid preservation table');return `SELECT r.kind,r.id,r.revision::text AS revision,r.sha256 FROM gallabox_private.${table} r WHERE (r.kind,r.id,r.revision)>($1,$2,$3::bigint) ORDER BY r.kind,r.id,r.revision LIMIT 500`; }
