export const READER_CATEGORIES=new Set(['renderer','evidence-overlay','identities','gps','resource','photo','status','reviews','review-write','review-migration','identity-write','photo-proposals','completed','other']);
export function readerUsageCategory(phase){return READER_CATEGORIES.has(phase)?phase:'other';}
export function validateReaderUsage(value){
 if(!value||Object.keys(value).sort().join(',')!=='category,encoding,responseBytes,status'||!READER_CATEGORIES.has(value.category)||!['identity','gzip','br'].includes(value.encoding)||!Number.isSafeInteger(value.responseBytes)||value.responseBytes<0||value.responseBytes>128*1024*1024||!Number.isInteger(value.status)||value.status<200||value.status>599)throw Error('Invalid reader usage measurement');
 return {...value};
}
