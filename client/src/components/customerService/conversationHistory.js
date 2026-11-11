import {idOf} from './serviceUtils';

// Several reviewed issues may share one source conversation. Count it once
// without losing any of its saved reviews or evidence links.
export function conversationHistory(issues = []) {
 const grouped=new Map();
 for(const issue of issues){
  const key=idOf(issue.conversationId)||idOf(issue);
  if(!grouped.has(key))grouped.set(key,{...issue.conversationHistory,conversationId:key,issues:[]});
  grouped.get(key).issues.push(issue);
 }
 return [...grouped.values()].sort((a,b)=>(Date.parse(b.lastMessageAt)||0)-(Date.parse(a.lastMessageAt)||0)||a.conversationId.localeCompare(b.conversationId));
}

export function conversationPreview(preview) {
 if(!preview)return 'Open the conversation to read the captured messages.';
 const author=preview.authorType==='customer'?'Customer':'Staff message';
 const attachments={image:'Image',audio:'Audio message',voice:'Voice message',video:'Video',document:'Document',location:'Shared location',contacts:'Shared contact',contact:'Shared contact',sticker:'Sticker'};
 return `${author}: ${preview.text?.trim()||attachments[preview.type]||'Message'}`;
}
