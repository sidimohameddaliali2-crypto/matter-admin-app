import path from 'node:path';
import {pathToFileURL} from 'node:url';
import mongoose from 'mongoose';
import {
  DriverAuditDirectImportError,readDriverAuditSeedConfig,runDriverAuditDirectImport,
} from '../services/driverAuditDirectImport.js';

export function parseDriverAuditSeedArgs(args){
  const [option,configPath,operation]=args;
  if(args.length<2||args.length>3||option!=='--config'||!path.isAbsolute(configPath)||
     (operation!==undefined&&!['--apply','--preflight'].includes(operation))){
    throw new DriverAuditDirectImportError('Usage: node server/scripts/driverAuditSeed.js --config /absolute/private/seed.json [--apply|--preflight]');
  }
  return {configPath,apply:operation==='--apply'};
}

async function connectExistingAppDatabase(uri){
  const connection=mongoose.createConnection(uri,{
    autoCreate:false,autoIndex:false,serverSelectionTimeoutMS:5000,socketTimeoutMS:45000,maxPoolSize:2,retryWrites:true,
  });
  try{
    await connection.asPromise();
    return {db:connection.db,close:()=>connection.close()};
  }catch(error){
    await connection.close().catch(()=>{});
    throw new DriverAuditDirectImportError('The existing app database could not be reached.',{cause:error});
  }
}

export async function runDriverAuditSeed({args,env,connect=connectExistingAppDatabase}){
  const {configPath,apply}=parseDriverAuditSeedArgs(args);
  const config=await readDriverAuditSeedConfig(configPath);
  if(env.DRIVER_AUDIT_IMPORT_ENABLED==='1'){
    throw new DriverAuditDirectImportError('Disable automatic imports before using direct audit import.');
  }
  const capacity=env.DRIVER_AUDIT_DEPLOY_CAPACITY_BYTES??env.DRIVER_AUDIT_CAPACITY_BYTES;
  const capacityBytes=/^[1-9][0-9]*$/.test(capacity??'')?Number(capacity):NaN;
  if(!Number.isSafeInteger(capacityBytes)||capacityBytes>256*1024*1024){
    throw new DriverAuditDirectImportError('Set an explicit audit storage capacity in bytes before direct import.');
  }
  const uri=env.MONGODB_URI;
  if(apply&&!uri)throw new DriverAuditDirectImportError('The existing app database configuration is required to apply an audit import.');
  const connection=uri?await connect(uri):null;
  try{
    if(connection&&!connection.db)throw new DriverAuditDirectImportError('The existing app database connection is unavailable.');
    return await runDriverAuditDirectImport({config,db:connection?.db,capacityBytes,apply});
  }finally{
    await connection?.close();
  }
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    await import('../loadEnv.js');
    const receipt=await runDriverAuditSeed({args:process.argv.slice(2),env:process.env});
    console.log(JSON.stringify(receipt));
  }catch(error){
    if(error?.code==='AUDIT_WRITER_BUSY')console.error('AUDIT_WRITER_BUSY: An existing or unresolved driver audit writer lock must be resolved first.');
    else if(error?.code==='AUDIT_CAPACITY')console.error('AUDIT_CAPACITY: The audit package exceeds its transfer or storage capacity.');
    else console.error(error instanceof DriverAuditDirectImportError?error.message:'The direct audit import did not complete.');
    process.exitCode=1;
  }
}
