import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
export async function acquireWorkerLock(file){
 // SQLite holds an OS-backed lock for the worker lifetime; process death releases it.
 // The legacy PID receipt is retained for interrupted-run recovery, not exclusion.
 const db=new DatabaseSync(file+'.sqlite');let acquired=false;
 try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');acquired=true;let recovered=false;
  try{const pid=Number(await fs.readFile(file,'utf8'));if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid worker lock; inspect without deleting evidence');try{process.kill(pid,0);throw Error('Collector already active');}catch(error){if(error.code!=='ESRCH')throw error;}await fs.rename(file,file+'.interrupted-'+randomUUID());recovered=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.writeFile(file,String(process.pid),{flag:'wx',mode:0o600});
  return {recovered,async release(){if((await fs.readFile(file,'utf8'))===String(process.pid))await fs.unlink(file);db.exec('ROLLBACK');db.close();}};
 }catch(e){if(acquired)db.exec('ROLLBACK');db.close();if(e.code==='ERR_SQLITE_ERROR')throw Error('Collector already active');throw e;}
}
