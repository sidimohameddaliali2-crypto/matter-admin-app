// These are provider conversation fields, independent of local review ownership.
export function gallaboxInboxState(row) {
 const status=row.status==='OPEN'?'open':row.status==='CLOSE'?'resolved':'unknown';
 const assigneeId=typeof row.assigneeId==='string'&&row.assigneeId?row.assigneeId:null;
 // Verified native conversation responses omit assigneeId for unassigned chats.
 // An unsupported status/partial object must not silently become an open backlog item.
 const assignment=assigneeId?'assigned':status!=='unknown'?'unassigned':'unknown';
 return {status,assignment,assigneeId,assigneeType:assigneeId?row.assigneeType||null:null,assigneeName:assigneeId&&row.user?.id===assigneeId?row.user.name||null:null,externalConversationId:row.id,providerUpdatedAt:row.updatedAt||null};
}
export function currentProviderInbox(threads) {
 return threads.map(t=>t.sourceMetadata?.providerInbox).filter(Boolean).sort((a,b)=>(Date.parse(b.observedAt)||0)-(Date.parse(a.observedAt)||0))[0]||{status:'unknown',assignment:'unknown'};
}
export function inboxFilters(filters) {
 const status=filters.status||'all',assignment=filters.assignment||'all';
 if(!['all','open','resolved','unknown'].includes(status)||!['all','mine','assigned','unassigned','unknown'].includes(assignment))throw Object.assign(new Error('Choose a valid inbox status and assignment.'),{statusCode:400});
 return {status,assignment,backlog:status==='open'||assignment==='unassigned'};
}

export function verifiedScopedProviderAuthors(actor,profile){
 if(!profile?.enabled||String(profile.userId)!==String(actor?._id))return [];
 return [...new Set((profile.externalAuthorIds||[]).filter(id=>typeof id==='string'&&/^gallabox:[^:]+:[^:]+:[^:]+$/.test(id)))];
}
