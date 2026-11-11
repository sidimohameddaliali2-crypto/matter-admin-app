import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
export async function writeImmutable(file,bytes,{prepared=()=>{}}={}){
 const temporary=file+'.'+randomUUID()+'.preparing';const handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(bytes);await handle.sync();await handle.close();await prepared();
  try{await fs.link(temporary,file);}catch(e){if(e.code!=='EEXIST')throw e;if(!(await fs.readFile(file)).equals(bytes))throw Error('Immutable file identity conflict');}
  const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
 }finally{await handle.close().catch(()=>{});await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function restoreHead(file,hydrate){let bytes;try{bytes=await fs.readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}return hydrate(JSON.parse(bytes));}
