import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import net from 'node:net';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const port=Number(process.env.CUSTOMER_SERVICE_PREVIEW_PORT||51160);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Use an available localhost port.');
await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`Local port ${port} is already in use. Open its existing preview or choose CUSTOMER_SERVICE_PREVIEW_PORT; this launcher will not stop another server.`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
const newest=async directory=>{let stamp=0;for(const item of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);stamp=Math.max(stamp,item.isDirectory()?await newest(file):(await fs.stat(file)).mtimeMs);}return stamp;};
const built=await fs.stat(path.join(root,'client/build/index.html')).catch(()=>null);
if(!built||process.argv.includes('--build')||Math.max(await newest(path.join(root,'client/src')),await newest(path.join(root,'client/public')))>built.mtimeMs){
 console.log('Building the isolated QA client…');
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['node_modules/react-scripts/bin/react-scripts.js','build'],{cwd:path.join(root,'client'),stdio:'inherit',env:{...process.env,REACT_APP_API_URL:'/api',GENERATE_SOURCEMAP:'false'}});child.once('error',reject);child.once('exit',resolve);});
 if(code!==0)throw Error('The QA client build failed; no preview started.');
}
Object.assign(process.env,{CUSTOMER_SERVICE_PREVIEW_PORT:String(port),CUSTOMER_SERVICE_ACTION_PREVIEW:'true',CUSTOMER_SERVICE_APP_LOGIN_PREVIEW:'false',CUSTOMER_SERVICE_TEST_ISOLATED:'true',CUSTOMER_SERVICE_SIDEBAR_SANDBOX:'true'});
await import('./customerServicePreview.js');
