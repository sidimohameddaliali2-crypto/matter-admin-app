// Filename scope is preserved from the original export comment. It is used only
// with an exact native message ID from an authenticated account/channel read.
export function matchHistoricalMessageIdentity(history,nativeMessages){
 const filename=history.sourceMetadata?.history?.sourceWorkbook;
 const account=typeof filename==='string'&&/^messagereport-([a-f0-9]{24})_\d{2}[A-Z][a-z]{2}\d{6}[AP]M-[A-Za-z0-9]+\.xlsx$/.exec(filename)?.[1];
 if(!account)return {state:'unverified_source'};
 const matches=nativeMessages.filter(n=>n.externalMessageId===history.externalMessageId&&n.scope?.split(':')[0]===account);
 if(!matches.length)return {state:'missing',account};
 if(matches.length!==1)return {state:'ambiguous',account};
 const message=matches[0];
 return{state:'matched',account,message,observationDifferences:[...(+new Date(message.sentAt)!==+new Date(history.sentAt)?['sentAt']:[]),...(message.type!==history.type?['type']:[]),...(message.text!==history.text?['text']:[])]};
}
