import postgres from 'postgres';
import {createHash} from 'node:crypto';
import {createHostedCapture} from './customerServiceHostedCapture.js';
const sql=postgres(Deno.env.get('SUPABASE_DB_URL'),{prepare:false,max:1,connect_timeout:10,idle_timeout:10});
// postgres.js encodes JSONB itself; shared pg adapter supplies JSON strings.
const argsFor=(text,args)=>args.map((value,i)=>new RegExp('\\$'+(i+1)+'::jsonb\\b').test(text)&&typeof value==='string'?JSON.parse(value):value);
const db={query:(text,args=[])=>sql.unsafe(text,argsFor(text,args)),transaction:fn=>sql.begin(tx=>fn((text,args=[])=>tx.unsafe(text,argsFor(text,args))))};
Deno.serve(async req=>{
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 const token=req.headers.get('authorization')?.replace(/^Bearer /,'');
 if(!token||!/^[a-f0-9]{64}$/.test(token))return new Response('Unauthorized',{status:401});
 try{
  const rows=await db.query('SELECT enabled,writer_mode FROM gallabox_private.worker_control WHERE singleton AND token_hash=$1',[createHash('sha256').update(token).digest('hex')]);
  if(!rows.length)return new Response('Unauthorized',{status:401});
  if(!rows[0].enabled)return Response.json({enabled:false});
  const [config]=await db.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='gallabox_capture_provider' LIMIT 1");
  if(!config)throw Error('Missing provider configuration');
  const envs=JSON.parse(config.decrypted_secret);
  const result=await createHostedCapture({db,envs}).run();
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch{
  console.error('Gallabox capture failed; inspect private checkpoints');
  return Response.json({error:'Capture unavailable; durable checkpoints retained'},{status:503});
 }
});
