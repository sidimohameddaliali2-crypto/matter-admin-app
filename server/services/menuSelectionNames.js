// Resolve lightweight Matter summary names without consulting Internal names
// or doing a detail lookup for every selection. Never guess across renewals.
export const menuSelectionNames = (rows, subscriptions) => {
  const byCustomer = new Map(), byEmail = new Map(), bySubscription = new Map();
  for (const sub of subscriptions) {
    if (sub.customer_id != null) {
      const key=String(sub.customer_id);byCustomer.set(key,[...(byCustomer.get(key)||[]),sub]);
    }
    const key=String(sub.email||'').trim().toLowerCase();
    if(key)byEmail.set(key,[...(byEmail.get(key)||[]),sub]);
    const subscriptionKey=String(sub.subscription_id??'').trim();
    if(subscriptionKey)bySubscription.set(subscriptionKey,[...(bySubscription.get(subscriptionKey)||[]),sub]);
  }
  return new Map(rows.map(row=>{
    const emailMatches=byEmail.get(String(row.matterEmail||row.email||'').trim().toLowerCase())||[];
    // An exact subscription rescues unlinked legacy rows after an email
    // change. It must never override a saved permanent Matter customer ID.
    const candidates=row.matterCustomerId ? byCustomer.get(String(row.matterCustomerId))||[]
      : emailMatches.length ? emailMatches : bySubscription.get(String(row.matterSubscriptionId??'').trim())||[];
    const active=candidates.filter(sub=>sub.subscription_status==='active');
    const exact=candidates.filter(sub=>String(sub.subscription_id)===String(row.matterSubscriptionId));
    const matches=active.length===1?active:exact.length===1?exact:candidates;
    const name=matches.length===1?String(matches[0].name||'').trim():'';
    const words=name.split(/\s+/);
    return [String(row._id),{firstName:name?words[0]:'',lastName:name?words.slice(1).join(' '):''}];
  }));
};
