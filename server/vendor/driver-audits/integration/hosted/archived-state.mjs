import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

const digest='[a-f0-9]{64}';
const allowed=new RegExp(`^(?:assets/(?:detail|history|query|archive|snapshot)-${digest}\\.json\\.gz|review-snapshots/${digest}\\.json\\.gz|photo-generations/${digest}\\.json|photos/${digest}\\.gz)$`);
async function openRegular(root,dir,name){
 if(typeof root!=='string'||!root)throw Object.assign(Error('Archive root unavailable'),{code:'ENOENT'});
 const parent=path.join(root,dir),parentStat=await fs.lstat(parent);
 if(!parentStat.isDirectory()||parentStat.isSymbolicLink())throw Error('Invalid archive directory');
 const file=path.join(parent,name),stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid archive file');
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const opened=await handle.stat();if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino)throw Error('Archive file changed');return handle;}catch(e){await handle.close();throw e;}
}
async function select(root,archiveRoot,dir,name){
 try{return {root,handle:await openRegular(root,dir,name)};}catch(e){if(e.code!=='ENOENT'||!archiveRoot)throw e;return {root:archiveRoot,handle:await openRegular(archiveRoot,dir,name)};}
}
export async function readArchivedFile(root,archiveRoot,relative){
 if(typeof relative!=='string'||!allowed.test(relative))throw Error('Invalid archive path');
 const [dir,name]=relative.split('/'),{handle}=await select(root,archiveRoot,dir,name);
 try{return await handle.readFile();}finally{await handle.close();}
}
export async function archivedInventoryRoot(root,archiveRoot,inventoryDigest){
 if(typeof inventoryDigest!=='string'||!/^[a-f0-9]{64}$/.test(inventoryDigest))throw Error('Invalid inventory digest');
 const {root:selected,handle}=await select(root,archiveRoot,'photo-inventories',inventoryDigest+'.json');
 await handle.close();return path.join(selected,'photo-inventories');
}
