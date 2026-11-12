import {promisify} from 'node:util';
import {brotliCompress,gzip,constants} from 'node:zlib';
const br=promisify(brotliCompress),gz=promisify(gzip);
function encoding(header=''){
 const accepted=new Map(String(header).toLowerCase().split(',').map(part=>{const [name,...params]=part.trim().split(';');const q=params.find(p=>p.trim().startsWith('q='));return [name,q===undefined?1:Number(q.trim().slice(2))];}));
 const quality=name=>{const q=accepted.get(name)??accepted.get('*')??0;return Number.isFinite(q)&&q>=0&&q<=1?q:0;};
 return quality('br')>0&&quality('br')>=quality('gzip')?'br':quality('gzip')>0?'gzip':null;
}
// Private process memory only. Full inputs or their verified digest identify bytes.
// Bound both original and encoded bytes; failures cannot poison later retries.
export function createPreviewResponseCompression({maxBytes=32*1024*1024,maxEntries=4}={}){
 const cache=new Map();let used=0;
 return async(body,acceptEncoding,{cacheable=false,contentTag}={})=>{
  const codec=encoding(acceptEncoding);
  if(!codec||typeof body!=='string'||Buffer.byteLength(body)<1024)return null;
  const size=Buffer.byteLength(body),key=contentTag?codec+':digest:'+contentTag:codec+':body:'+body;
  if(cacheable&&cache.has(key)){const entry=cache.get(key);cache.delete(key);cache.set(key,entry);return entry.promise;}
  const entry={size};
  entry.promise=(async()=>{const bytes=await(codec==='br'?br(body,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}):gz(body));if(cache.get(key)===entry){entry.size+=bytes.length;used+=bytes.length;trim();}return {bytes,encoding:codec};})().catch(error=>{if(cache.get(key)===entry){used-=entry.size;cache.delete(key);}throw error;});
  function trim(){while(used>maxBytes||cache.size>maxEntries){const first=cache.keys().next().value;used-=cache.get(first).size;cache.delete(first);}}
  if(cacheable&&size<=maxBytes){cache.set(key,entry);used+=size;trim();}
  return entry.promise;
 };
}
