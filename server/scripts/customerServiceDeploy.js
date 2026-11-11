// Explicit release setup only. Application startup never configures access,
// seeds accounts, runs migrations or starts a second capture writer.
import '../loadEnv.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import express from 'express';
import User from '../models/User.js';
import {configureCustomerServiceDeployment,customerServicePageGrant,verifyCustomerServiceRelease} from '../services/customerServiceDeployment.js';
import {createCloudStore} from '../services/customerServiceCloudStore.js';
import {startCustomerServiceDestination} from '../services/customerServiceDestination.js';
if(process.argv[2]==='--verify'){
 const port=Number(process.env.PORT||5000);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid existing app port.');
 console.log(JSON.stringify(await verifyCustomerServiceRelease({origin:'http://127.0.0.1:'+port})));process.exit(0);
}
if(process.argv[2]!=='--apply')throw Error('Explicit --apply is required for release connection/page setup.');
if(!process.env.MONGODB_URI)throw Error('Existing app database configuration must be present.');
const serverRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {directory,env}=await configureCustomerServiceDeployment({serverRoot,encoded:process.env.MATTER_CS_RUNTIME_B64});
const store=createCloudStore({env});let runtime;
try{
 runtime=await startCustomerServiceDestination({app:express(),env,store});
 const subjects=await store.query("SELECT COALESCE(jsonb_agg(l.subject),'[]') FROM gallabox_private.staff_login l JOIN gallabox_private.staff_directory d ON d.id=l.staff_id WHERE l.provider='matter' AND l.active AND d.active AND EXISTS(SELECT 1 FROM gallabox_private.inbox_record r WHERE r.kind='servicestaffprofiles' AND r.body->>'userId'=l.staff_id AND r.body->>'enabled'='true')");
 if(!Array.isArray(subjects)||!subjects.length||subjects.some(id=>!/^[a-f\d]{24}$/i.test(id)))throw Error('Verified existing staff login links are required.');
 await mongoose.connect(process.env.MONGODB_URI,{autoIndex:false});
 const accounts=await User.find({_id:{$in:subjects}}).select('_id role isActive permissions permissionsConfigured updatedAt').lean();
 if(!accounts.some(account=>account.isActive&&['super_admin','admin','manager','dispatcher','store_keeper','viewer','kitchen'].includes(account.role)))throw Error('No active eligible existing app account matches the verified staff links.');
 const initializedPath=path.join(directory,'initial-page-setup.json');
 const initialSetupComplete=await fs.stat(initializedPath).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
 const plans=accounts.map(account=>({account,set:customerServicePageGrant(account,{initialSetupComplete})})).filter(plan=>plan.set);
 const receipt={at:new Date().toISOString(),linked:subjects.length,found:accounts.length,plans:plans.map(({account,set})=>({before:account,set})),applied:[]};
 const receiptPath=path.join(directory,'page-grants-'+Date.now()+'.json');
 await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
 for(const {account,set}of plans){
  const result=await User.updateOne({_id:account._id,updatedAt:account.updatedAt,isActive:true,role:account.role},{$set:set});
  if(result.matchedCount!==1)throw Error('A staff account changed concurrently. Retain the saved grant receipt and rerun setup.');
  receipt.applied.push(String(account._id));await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2),{mode:0o600});
 }
 if(!initialSetupComplete)await fs.writeFile(initializedPath,JSON.stringify({at:new Date().toISOString(),receipt:path.basename(receiptPath),note:'Initial existing-member page setup complete. Future deploys preserve later administrator page revocations.'}),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({customerService:'verified',canonicalStorage:'supabase',linkedExistingLogins:subjects.length,pagePermissionsAdded:receipt.applied.length,newAccounts:0,passwordChanges:0,workflowGrantsChanged:0}));
}finally{await runtime?.stop();await store.close();await mongoose.disconnect();}
