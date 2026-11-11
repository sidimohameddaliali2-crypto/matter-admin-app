import React from 'react';
import {formatDubai,useServiceResource} from './serviceUtils';
import {conversationHistory} from './conversationHistory';

export default function CustomerSummary({conversation,qaContext,qaMode=false,onOpenConversation,onViewAccount}){
 const customerId=conversation?.linkOverride?conversation.navigationCustomerId:conversation?.customerId;
 const context=useServiceResource(!qaMode&&customerId?`/customers/${encodeURIComponent(customerId)}/context`:null);
 if(!conversation)return null;
 const data=qaContext||context.data;
 const subscription=data?.subscriptions?.[0]||data?.subscription;
 const history=qaContext?.previousRequests||conversationHistory(data?.issues||[]).filter(item=>item.conversationId!==String(conversation._id)).map(item=>({conversationId:item.conversationId,title:'Conversation',outcome:item.closedAt?'Chat closed':'Earlier conversation',at:item.closedAt||item.startedAt||item.firstMessageAt}));
 return <section className="cs-customer-summary" aria-label="Customer summary">
  <div><strong>{data?.customer?.name||conversation.customerName||'Customer'}</strong>{!qaMode&&customerId&&onViewAccount&&<button type="button" onClick={onViewAccount}>Account</button>}</div>
  {subscription?<p>{subscription.planName||subscription.name||'Plan'}<span> · {String(subscription.status||subscription.subscriptionStatus||'Status unavailable').replaceAll('_',' ')}</span></p>:context.loading?<p>Loading customer…</p>:<p>{context.error?'Customer information unavailable':customerId?'Plan not supplied':'Account not linked'}</p>}
  {history.length>0&&<div className="cs-previous-request">{history.slice(0,2).map(item=><button type="button" key={item.conversationId} onClick={()=>onOpenConversation?.(item.conversationId)}><span>Previous: {item.title} · {item.outcome}</span>{item.at&&<time>{formatDubai(item.at).split(',')[0]}</time>}</button>)}</div>}
  {context.error&&<button type="button" onClick={context.refresh}>Retry customer information</button>}
 </section>;
}
