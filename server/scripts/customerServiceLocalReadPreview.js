// Explicit loopback-only viewing mode for the local prototype. The destination
// app's login and staff grants are unchanged. No identity or grant is persisted.
import fs from 'node:fs';
import path from 'node:path';
import Staff from '../models/ServiceStaffProfile.js';
import {sourceStaffUsers} from '../services/customerServiceStaffDirectory.js';
import {createServiceStaffAuth} from '../services/customerServiceStaffAuth.js';
import {getServiceCapabilities} from '../services/customerServicePolicy.js';

const denied=()=>Object.assign(Error('This local preview only reads live records. Changes are not saved.'),{statusCode:403});
export function readOnlyPreviewStore(store){
 const reject=async()=>{throw denied();};
 return {...store,query:(sql,options={})=>{if(options.write)throw denied();return store.query(sql,{...options,write:false});},transaction:reject,stage:reject,commit:reject};
}

export async function localReadPreviewIdentity(){
 const profiles=await Staff.find({enabled:true,mode:'supervisor'}).lean();
 const users=await sourceStaffUsers(profiles.map(p=>p.userId));
 // Reuse an existing linked read scope. Prefer its existing reporting access.
 const profile=[...profiles].sort((a,b)=>Number(Boolean(b.grants?.includes('reportingAccess')))-Number(Boolean(a.grants?.includes('reportingAccess')))).find(p=>users.some(u=>String(u._id)===String(p.userId)));
 const source=users.find(u=>String(u._id)===String(profile?.userId));
 if(!source)throw Error('An existing linked supervisor read scope is required for the local preview.');
 return {profile,user:{_id:String(source._id),isActive:true,role:'viewer',profile:{firstName:'Local preview',lastName:''},permissions:{customerService:true},permissionsConfigured:true,serviceOnly:true,localPreview:true}};
}

export async function installLocalReadPreview(app,{enabled,origin,root,identity}){
 const url=new URL(origin);
 if(enabled!==true||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw Error('Local read preview requires explicit enablement and loopback binding.');
 const {user,profile}=identity||await localReadPreviewIdentity();
 if(!getServiceCapabilities(user,profile).supervise)throw Error('Existing supervisor read access is unavailable.');
 // The loopback gate is the preview's authority. Reuse the existing verified-
 // actor/read-scope machinery without issuing any identity-provider session.
 const verifier=createServiceStaffAuth({supabase:{},resolve:async()=>user,fetchImpl:async()=>Response.json({success:true,data:{user}})});
 const verified=await verifier.authenticate('Bearer cs-matter.local-read-preview');
 const auth={authenticate:async()=>verified};
 app.set('customerServiceAuth',auth);
 app.use((req,res,next)=>{
  const navigation=req.method==='GET'&&!req.path.startsWith('/api/')&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==url.host||req.headers.origin&&req.headers.origin!==url.origin||req.headers['sec-fetch-site']==='cross-site'&&!navigation)return res.sendStatus(403);
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"frame-ancestors 'self'"});
  const reportingSession=req.path==='/api/staff-reporting/session'&&['POST','DELETE'].includes(req.method);
  if(!['GET','HEAD'].includes(req.method)&&!reportingSession)return res.status(403).json({success:false,message:denied().message});
  next();
 });
 app.get('/api/auth/me',(req,res)=>res.json({success:true,data:{user}}));
 app.get('/api/customer-service/me',(req,res)=>res.json({success:true,data:{capabilities:{...getServiceCapabilities(user,profile),previewReadOnly:true},profile:{...profile,displayName:'Local preview'}}}));
 app.get(['/','/local-review','/login','/customer-service/sign-in'],(req,res)=>res.redirect('/customer-service/chats?period=all'));
 app.get('/test/session/:role',(req,res)=>res.sendStatus(404));
 const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');
 const bootstrap=`<script>localStorage.setItem('token','cs-preview.read-only');localStorage.setItem('user',${json(JSON.stringify(user))});</script>`;
 app.get(['/customer-service','/customer-service/*'],(req,res)=>res.type('html').send(fs.readFileSync(path.join(root,'client/build/index.html'),'utf8').replace('<head>','<head>'+bootstrap)));
 return {auth,user};
}
