import fs from 'node:fs/promises';
import path from 'node:path';
import {X509Certificate,randomUUID} from 'node:crypto';
import {effectivePermissions} from '../models/User.js';
import {SERVICE_STAFF_ROLES} from './customerServicePolicy.js';

export async function verifyCustomerServiceRelease({origin,fetchImpl=fetch,attempts=30,wait=()=>new Promise(resolve=>setTimeout(resolve,1000))}){
 for(let n=0;n<attempts;n++){
  try{
   const health=await fetchImpl(origin+'/api/health',{signal:AbortSignal.timeout(3000)});
   const body=health.ok?await health.json():null;
   const service=await fetchImpl(origin+'/api/customer-service/me',{signal:AbortSignal.timeout(3000)});
   if(body?.success===true&&body.database==='connected'&&service.status===401)return {existingAppHealthy:true,canonicalCustomerServiceReady:true,staffAuthenticationRequired:true};
  }catch{}
  if(n+1<attempts)await wait();
 }
 throw Error('Existing app health and the canonical Customer Service authentication boundary were not both verified.');
}

export function customerServicePageGrant(account,{initialSetupComplete=false}={}){
 if(initialSetupComplete)return null;
 if(!account?.isActive||!SERVICE_STAFF_ROLES.includes(account.role))return null;
 const current=effectivePermissions(account);
 if(current.customer_service===true)return null;
 // Explicitly configuring a formerly role-default account must preserve every
 // page it could already use. No role, password or workflow grant changes.
 return account.permissionsConfigured?{'permissions.customer_service':true}:{
  ...Object.fromEntries(Object.entries({...current,customer_service:true}).map(([key,value])=>['permissions.'+key,value])),
  permissionsConfigured:true
 };
}

export async function configureCustomerServiceDeployment({serverRoot,encoded}){
 if(typeof encoded!=='string'||!encoded||encoded.length>131072||!/^[A-Za-z0-9+/=]+$/.test(encoded))throw Error('A private customer-service connection secret is required.');
 let value;try{value=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch{throw Error('Invalid private customer-service connection secret.');}
 const credentials=value?.credentials;
 if(credentials?.projectRef!=='trhhjfgfmxofxhnzocks'||credentials.actualRegion!=='eu-central-1'||typeof credentials.databasePassword!=='string'||!credentials.databasePassword||credentials.databasePassword.length>4096||typeof value.ca!=='string')throw Error('Unexpected canonical customer-service database configuration.');
 try{new X509Certificate(value.ca);}catch{throw Error('The customer-service database requires its verified CA certificate.');}
 const directory=path.join(serverRoot,'.private/customer-service');
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 if((await fs.lstat(directory)).isSymbolicLink())throw Error('Private connection directory must not be a symbolic link.');
 await fs.chmod(directory,0o700);
 const write=async(file,content)=>{const temporary=file+'.'+randomUUID();try{await fs.writeFile(temporary,content,{mode:0o600,flag:'wx'});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}};
 const credentialsPath=path.join(directory,'supabase.credentials.json'),caPath=path.join(directory,'supabase-ca.crt');
 const envPath=path.join(serverRoot,'.env.local');
 const original=await fs.readFile(envPath,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
 const env={CUSTOMER_SERVICE_STORAGE:'supabase',CUSTOMER_SERVICE_SUPABASE_CREDENTIALS_PATH:credentialsPath,CUSTOMER_SERVICE_SUPABASE_CA_PATH:caPath};
 const filtered=original.split(/\r?\n/).filter(line=>!/^\s*(?:export\s+)?CUSTOMER_SERVICE_(?:STORAGE|SUPABASE_CREDENTIALS_PATH|SUPABASE_CA_PATH)\s*=/.test(line));
 const next=filtered.join('\n').replace(/\n*$/,'\n')+Object.entries(env).map(([key,val])=>key+'='+JSON.stringify(val)).join('\n')+'\n';
 if(next!==original)await fs.writeFile(path.join(directory,'env-before-'+Date.now()+'.txt'),original,{mode:0o600,flag:'wx'});
 await write(credentialsPath,JSON.stringify({projectRef:credentials.projectRef,actualRegion:credentials.actualRegion,databasePassword:credentials.databasePassword}));
 await write(caPath,value.ca);
 if(next!==original)await write(envPath,next);
 return {directory,env};
}
