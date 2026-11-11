import {isDeepStrictEqual} from 'node:util';
import {normalizeServiceMessage} from './customerServiceCaptureFormat.js';
// Metadata-only recovery: never rewrite message evidence, ownership, or reviews.
export function recoveredContextPatch(existing, raw, {source,scope}) {
  const message=normalizeServiceMessage(raw,{source,scope});
  if(existing.source!==source||existing.scope!==scope||existing.externalMessageId!==message.externalMessageId||existing.externalConversationId!==message.externalConversationId||+new Date(existing.sentAt)!==+message.sentAt||existing.type!==message.type||existing.text!==message.text||existing.externalAuthorId!==message.externalAuthorId)throw new Error('Source evidence differs from the saved message');
  if(existing.sourceMetadata?.externalContactId&&existing.sourceMetadata.externalContactId!==message.sourceMetadata?.externalContactId)throw new Error('Source contact differs from the saved message');
  const patch={};
  if(!existing.sourceMetadata?.externalContactId&&message.sourceMetadata?.externalContactId)patch['sourceMetadata.externalContactId']=message.sourceMetadata.externalContactId;
  for(const field of ['replyContext','systemEvent','media','location','nativeContent','direction','nativeMessageId']){
    const value=message.sourceMetadata?.[field];
    if(value&&!isDeepStrictEqual(value,existing.sourceMetadata?.[field]))patch[`sourceMetadata.${field}`]=value;
  }
  if(message.sourceMetadata?.media&&existing.mediaState!=='available')patch.mediaState='available';
  return patch;
}
