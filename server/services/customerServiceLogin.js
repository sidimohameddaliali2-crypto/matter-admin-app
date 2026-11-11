import express from 'express';
import {createHostedAuth} from './customerServiceSession.js';
import {createServiceStaffAuth,protectService} from './customerServiceStaffAuth.js';
import {resolveStaffLogin} from './customerServiceStaffDirectory.js';
import {cloudSqlText as lit} from './customerServiceCloudStore.js';
export function installServiceLogin(app,{store,publishableKey,cookieKey,fetchImpl=fetch}){
 const base='https://trhhjfgfmxofxhnzocks.supabase.co';
 const session=createHostedAuth({supabaseUrl:base,publishableKey,cookieKey,cookieName:'__Host-matter_cs',fetchImpl,
  membership:async id=>({active:Boolean(await resolveStaffLogin('supabase',id)),role:'reviewer'}),
  sessionActive:async({userId,sessionId})=>store.query(`SELECT EXISTS(SELECT 1 FROM auth.sessions WHERE id=${lit(sessionId)}::uuid AND user_id=${lit(userId)}::uuid AND (not_after IS NULL OR not_after>now()));`)});
 const auth=createServiceStaffAuth({supabase:session,resolve:resolveStaffLogin,fetchImpl});app.set('customerServiceAuth',auth);
 const router=express.Router();let attempts=[];
 router.post('/login',async(req,res)=>{try{
  const {email,password,provider='supabase'}=req.body||{};if(!['supabase','matter'].includes(provider)||typeof email!=='string'||email.length>320||typeof password!=='string'||!password||password.length>1024)return res.sendStatus(400);
  attempts=attempts.filter(at=>at>Date.now()-60000);if(attempts.length>=10)return res.status(429).json({message:'Wait a minute before trying again.'});attempts.push(Date.now());
  const r=await fetchImpl(provider==='supabase'?base+'/auth/v1/token?grant_type=password':'https://matterapp.online/api/auth/login',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',...(provider==='supabase'?{apikey:publishableKey}:{})},body:JSON.stringify({email,password})});if(!r.ok){await r.body?.cancel();return res.status(401).json({message:'Sign-in was not accepted.'});}const j=await r.json();let token;if(provider==='supabase'){const issued=await session.issue({accessToken:j.access_token,refreshToken:j.refresh_token});token='cs-sb.'+issued.cookie.split(';')[0].split('=')[1];}else token='cs-matter.'+j.data?.token;
  const {user}=await auth.authenticate('Bearer '+token);res.set('Cache-Control','no-store').json({success:true,data:{user,token}});
 }catch(e){res.status(e.statusCode||e.status||503).json({message:'Sign-in or customer-service membership could not be verified.'});}});
 router.get('/me',protectService,(req,res)=>res.set('Cache-Control','no-store').json({success:true,data:{user:req.user}}));app.use('/api/auth',router);
 app.get(['/login','/customer-service/sign-in'],(req,res)=>res.set('Cache-Control','no-store').type('html').send(serviceSignInHtml));
 return {auth,session};
}
export const serviceSignInHtml=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Matter customer service</title><body style="font:16px system-ui;background:#f7f5ee;color:#111733"><main style="max-width:400px;margin:12vh auto;padding:24px"><h1>Matter customer service</h1><form><label>Account<select name="provider" style="display:block;width:100%;padding:12px;margin:8px 0 20px"><option value="supabase">Reporting account</option><option value="matter">Matter app account</option></select></label><label>Email<input type="email" name="email" autocomplete="username" required style="display:block;width:94%;padding:12px;margin:8px 0 20px"></label><label>Password<input name="password" type="password" autocomplete="current-password" required style="display:block;width:94%;padding:12px;margin:8px 0 20px"></label><button style="padding:12px 24px">Sign in</button></form><p role="status"></p></main><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const form=e.target,button=form.querySelector('button'),message=document.querySelector('[role=status]');button.disabled=true;try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))}),j=await r.json();if(!r.ok)throw Error(j.message||'Sign-in unavailable');form.elements.password.value='';localStorage.setItem('token',j.data.token);localStorage.setItem('user',JSON.stringify(j.data.user));location.replace('/customer-service/chats');}catch(x){message.textContent=x.message;}finally{button.disabled=false;}};</script></html>`;
