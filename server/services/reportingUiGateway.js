import {randomBytes} from 'node:crypto';
const prefix='/api/reporting-ui';
const writers=new Set(['super_admin','admin','manager','dispatcher']);
const readPath=p=>p==='/'||p==='/api/reporting/status'||p==='/api/reporting/reviews'||p==='/api/reporting/photo-proposals'||/^\/report-data\/(detail|history|query|archive|snapshot)-[a-f0-9]{64}\.json$/.test(p)||['/api/reporting/photo','/api/reporting/photo/image'].includes(p);
const writePath=p=>['/api/reporting/reviews','/api/reporting/reviews/migrate','/api/reporting/fresh-run','/api/reporting/api-refresh'].includes(p);
const cookieValue=req=>String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('matter_report_session='))?.slice(22);
export function createReportingUiGateway({express,protect,checkPermission,origin,upstream,enabled=false,now=Date.now}){
 const router=express.Router();if(!enabled)return router;
 const target=new URL(origin);if(target.origin!==origin||!['http:','https:'].includes(target.protocol))throw Error('Reporting requires an explicit app origin');
 const sessions=new Map(),cookie=(id,age=90)=>`matter_report_session=${id}; HttpOnly; SameSite=Strict; Path=${prefix}; Max-Age=${age}${target.protocol==='https:'?'; Secure':''}`;
 router.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'});if(req.headers.host!==target.host||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'Same-origin reporting access required'});next();});
 router.use(express.json({limit:'1mb'}));
 router.delete('/session',(req,res)=>{if(req.headers.origin!==origin)return res.sendStatus(403);sessions.delete(cookieValue(req));res.set('Set-Cookie',cookie('',0));res.status(204).end();});
 router.post('/session',protect,checkPermission('reports'),(req,res)=>{
  if(req.headers.origin!==origin||!req.is('application/json'))return res.sendStatus(403);
  for(const [id,s]of sessions)if(s.until<=now())sessions.delete(id);
  if(sessions.size>=5000)return res.status(503).json({error:'Reporting session capacity reached'});
  const existing=cookieValue(req),authorization=req.headers.authorization;let id=existing,s=existing&&sessions.get(existing);
  if(!s||s.authorization!==authorization){if(existing)sessions.delete(existing);id=randomBytes(32).toString('hex');s={authorization,csrf:randomBytes(32).toString('hex'),generation:randomBytes(16).toString('hex')};}
  s.until=now()+90000;sessions.set(id,s);res.set('Set-Cookie',cookie(id));res.json({frame:prefix+'/?screen=reports&view=1&tab=mirror',generation:s.generation,expiresInSeconds:90});
 });
 router.use((req,res,next)=>{const s=sessions.get(cookieValue(req));if(!s||s.until<=now())return res.status(401).json({error:'Reporting session expired. Reconnect from the Report page.'});req.reportingSession=s;req.headers.authorization=s.authorization;next();},protect,checkPermission('reports'));
 router.use(async(req,res)=>{
  try{
   const url=new URL(req.url,origin),p=url.pathname,write=req.method==='POST',loadSavedHistory=p==='/api/reporting/reviews/migrate';
   if(!['GET','HEAD','POST'].includes(req.method))return res.sendStatus(405);
   if(write&&!writePath(p))return res.sendStatus(p.startsWith('/api/reporting/')?405:404);
   if(!write&&!readPath(p))return res.sendStatus(404);
   if(p.startsWith('/report-data/')&&url.search)return res.sendStatus(404);
   if(write&&(req.headers.origin!==origin||!req.is('application/json')||req.headers['x-reporting-token']!==req.reportingSession.csrf||!loadSavedHistory&&!writers.has(req.user.role)))return res.status(403).json({error:'This reporting action is not authorized'});
   let body=req.body;if(write&&p==='/api/reporting/reviews')body={...body,authorName:req.user.name||String(req.user._id)};
   // The standalone renderer's initial "migrate" call loads the shared journal.
   // Browser-supplied history is never imported into the staff service.
   const result=await upstream({method:write&&!loadSavedHistory?'POST':'GET',path:loadSavedHistory?'/api/reporting/reviews':p==='/'?'/':p+url.search,body:write&&!loadSavedHistory?body:undefined,actor:{id:String(req.user._id),name:req.user.name,role:req.user.role}});
   if(!result||result.status<200||result.status>=300)return res.status(result?.status===409?409:503).json({error:result?.status===409?'The report or response changed. Reload before saving.':'Reporting service unavailable. Saved evidence remains retained.'});
   let bytes=result.body,type=result.type;
   if(p==='/'){
    if(!/^text\/html/.test(type))throw Error('Invalid reporting document');
    const embeddingStyle='<style>.dashboard-topbar,[aria-label="Dashboard pages"],.theme-drawer,.mm-app-header,.mm-drawer-layer{display:none!important}.mm-workspace-shell.mm-navigation-open>.mm-content,.mm-workspace-shell.mm-navigation-open>.mm-snapshot-foot{margin-left:0!important}</style>';
    bytes=Buffer.from(bytes.toString().replace(/<head([^>]*)>/,'<head$1><base href="'+prefix+'/">'+embeddingStyle).replaceAll('/api/reporting/',prefix+'/api/reporting/'));
    res.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'");
   }else if(p==='/api/reporting/status'){
    const data=JSON.parse(bytes);bytes=Buffer.from(JSON.stringify({...data,token:req.reportingSession.csrf,readOnly:!writers.has(req.user.role),staffIdentity:{id:String(req.user._id),name:req.user.name}}));
   }else if(p==='/api/reporting/photo'){
    const data=JSON.parse(bytes);for(const k of ['thumbnail','original'])if(typeof data[k]==='string'&&data[k].startsWith('/api/reporting/'))data[k]=prefix+data[k];bytes=Buffer.from(JSON.stringify(data));
   }
   if(sessions.get(cookieValue(req))!==req.reportingSession||req.reportingSession.until<=now())return res.status(401).json({error:'Reporting session expired'});
   // Recheck current staff access after a potentially slow evidence read.
   return protect(req,res,()=>checkPermission('reports')(req,res,()=>{res.type(type);res.status(200).send(req.method==='HEAD'?undefined:bytes);}));
  }catch{res.status(503).json({error:'Reporting service unavailable. Saved evidence remains retained.'});}
 });
 return router;
}
