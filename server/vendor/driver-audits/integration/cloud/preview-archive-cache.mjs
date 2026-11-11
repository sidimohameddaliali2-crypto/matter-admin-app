import {Readable} from 'node:stream';import {createHash} from 'node:crypto';
// Frozen preview metadata only, copied from verified content-addressed storage.
// This adapter exposes no writes and never handles mutable review/session state.
export function previewArchiveTransport({remote,has,read,readAsync}){
 return {async readObject(key,options){
  if(!/^[a-f0-9]{64}\.gz$/.test(key))throw Error('Invalid archive key');
  const file='archive-'+key.slice(0,-3)+'.private.bin';
  if(!has(file))return remote.readObject(key,options);
  const bytes=readAsync?await readAsync(file):read(file);if(!Number.isSafeInteger(options?.maxBytes)||bytes.length>options.maxBytes)throw Error('Bundled archive exceeds limit');
  if(createHash('sha256').update(bytes).digest('hex')!==key.slice(0,-3))throw Error('Bundled archive integrity failure');
  return Readable.from([bytes]);
 }};
}
