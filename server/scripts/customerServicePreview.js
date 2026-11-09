// Local, cloud-backed staff inbox. No driver jobs, provider sends, or capture worker.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import dotenv from 'dotenv';
import {createCloudStore,configureCloudInbox} from '../services/customerServiceCloudStore.js';
import {createCloudInboxReader} from '../services/customerServiceCloudInbox.js';
import {installServiceLogin} from '../services/customerServiceLogin.js';
import service from '../routes/customerService.js';
import data from '../routes/customerServiceData.js';
import customers from '../routes/customerServiceCustomers.js';
import media from '../routes/customerServiceMedia.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=name=>dotenv.parse(fs.readFileSync(path.join(root,'server',name)));
const env={...read('.env.supabase.local'),...read('.env.service-auth.local')};
const store=createCloudStore({env});
const control=await store.query("SELECT jsonb_build_object('capture',writer_mode,'workflow',workflow_mode) FROM gallabox_private.worker_control WHERE singleton;");
if(control?.capture!=='cloud'||control?.workflow!=='cloud')throw Error('Verified cloud capture and workflow must be active.');
configureCloudInbox({store,hosted:true,workflow:true,reader:createCloudInboxReader(store)});
const app=express();app.use(express.json());
installServiceLogin(app,{store,publishableKey:env.CUSTOMER_SERVICE_AUTH_PUBLISHABLE_KEY,cookieKey:Buffer.from(env.CUSTOMER_SERVICE_AUTH_COOKIE_KEY,'hex')});
app.use('/api/customer-service',media,customers,data,service);
app.use(express.static(path.join(root,'client/build')));
app.get('*',(req,res)=>res.sendFile(path.join(root,'client/build/index.html')));
const port=Number(process.env.CUSTOMER_SERVICE_PREVIEW_PORT||50994);
const server=app.listen(port,'127.0.0.1',()=>console.log(`Local staff inbox: http://127.0.0.1:${port}/customer-service/chats`));
async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));configureCloudInbox(null);await store.close();}
process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
