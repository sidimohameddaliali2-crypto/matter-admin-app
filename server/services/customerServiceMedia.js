// Verified 2026-11-06: native media.path uses this host, with account/file paths.
// Provider URLs remain private and no API credentials are forwarded to storage.
export const SERVICE_MEDIA_LIMIT = 20 * 1024 * 1024;
const documents = new Set(['application/pdf','text/html','application/octet-stream','application/zip','application/x-zip-compressed','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const supported = new Set(['image/jpeg','image/png','image/webp','image/gif','audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/webm','video/mp4','video/webm','application/pdf']);
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });
export function sanitizeServiceMedia(value, {source, scope, type} = {}) {
  if(source !== 'gallabox' || !value || typeof value.url !== 'string' || value.url.length > 2048) return null;
  const mediaType=type==='other'&&['image','audio','video','document'].includes(value.type)?value.type:type;
  const mimeType = String(value.mimeType || '').split(';')[0].trim().toLowerCase();
  if(!['image','audio','video','document'].includes(mediaType))return null;
  if(mimeType&&(!(supported.has(mimeType)||documents.has(mimeType)) || !(documents.has(mimeType)?mediaType==='document':mimeType.split('/')[0]===mediaType))) return null;
  try {
    const url = new URL(value.url), account = String(scope || '').split(':')[0];
    const parts = url.pathname.split('/');
    if(url.protocol !== 'https:' || !['files.gallabox.com','gabx-prod-files.s3.amazonaws.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || parts.length !== 3 || parts[1] !== account || !/^[a-zA-Z0-9_-]{1,120}$/.test(account) || !/^[a-zA-Z0-9_.-]{1,255}$/.test(parts[2]) || parts[2] === '.' || parts[2] === '..') return null;
    return {url:url.href,mimeType,...(type==='other'||!mimeType?{type:mediaType}:{})};
  } catch {return null;}
}
export async function fetchServiceMedia(message, {fetchImpl = fetch} = {}) {
  const media = sanitizeServiceMedia(message.sourceMetadata?.media, message);
  if(!media) throw error('This attachment is unavailable or its format is unsupported.', 404);
  let response;
  try { response = await fetchImpl(media.url, {method:'GET', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000), headers:{Accept:media.mimeType||((media.type||message.type)==='document'?'application/*,text/html':`${media.type||message.type}/*`)}}); }
  catch {throw error('Attachment could not be loaded. Retry later.', 502);}
  if(!response.ok) {await response.body?.cancel();throw error([401,403,404,410].includes(response.status) ? 'Attachment is unavailable or expired at the source. Refresh capture and retry.' : 'Attachment could not be loaded. Retry later.', [401,403,404,410].includes(response.status) ? 410 : 502);}
  const actual = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if((media.mimeType&&actual!==media.mimeType)||!actual||!sanitizeServiceMedia({...media,mimeType:actual},message)) {await response.body?.cancel();throw error('Attachment format could not be verified.', 415);}
  if(Number(response.headers.get('content-length') || 0) > SERVICE_MEDIA_LIMIT) {await response.body?.cancel();throw error('Attachment exceeds the 20 MB playback limit.', 413);}
  const reader = response.body?.getReader(); if(!reader) throw error('Attachment is empty.', 502);
  const chunks=[];let size=0;
  try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>SERVICE_MEDIA_LIMIT){await reader.cancel();throw error('Attachment exceeds the 20 MB playback limit.',413);}chunks.push(value);}}
  catch(e){if(e.statusCode)throw e;throw error('Attachment download was interrupted. Retry.',502);}
  finally {reader.releaseLock();}
  if(!size) throw error('Attachment is empty.', 502);
  return {body:Buffer.concat(chunks),mimeType:actual};
}
// Authorization must finish before any lookup or provider request.
export async function loadServiceIssueMedia({issueId,messageId,actor,profile}, {getDetail,getMessage,fetchImpl} = {}) {
  const detail = await getDetail({issueId,actor,profile});
  if(!detail.messages.some(m => String(m._id) === messageId)) throw error('Attachment not found in this conversation.',404);
  const message = await getMessage(messageId);
  if(!message || String(message.conversationId) !== String(detail.issue.conversationId)) throw error('Attachment not found in this conversation.',404);
  return fetchServiceMedia(message,{fetchImpl});
}
// Inbox attachments are available to active service members independently of
// review assignment, but only after validating the exact captured conversation.
export async function loadServiceConversationMedia({conversationId,messageId,actor,profile},{getConversation,getMessage,fetchImpl}={}){
 const conversation=await getConversation({conversationId,actor,profile});
 const message=await getMessage(messageId);
 if(!message||String(message.conversationId)!==String(conversation._id))throw error('Attachment not found in this conversation.',404);
 return fetchServiceMedia(message,{fetchImpl});
}
