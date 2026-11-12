import '../loadEnv.js';
import path from 'node:path';
import {createBudgetedAuditArchive} from '../vendor/driver-audits/integration/cloud/driver-audit-archive.mjs';
import {stageAuditHandoff} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import {createCloudState} from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import {createHostedRpc} from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import {createSupabaseArchiveTransport} from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';

async function main(){
 const [rootFlag,root,hashFlag,sha,baseline]=process.argv.slice(2);
 if(rootFlag!=='--root'||!path.isAbsolute(root||'')||hashFlag!=='--sha256'||!/^[a-f0-9]{64}$/.test(sha||'')||
    baseline!==undefined&&baseline!=='--with-baseline'||process.argv.length>7)throw Error('Invalid audit stage arguments');
 const secret=process.env.DRIVER_AUDIT_DEPLOY_SECRET||process.env.DRIVER_AUDIT_SUPABASE_SECRET;
 const rpc=createHostedRpc({secret}),state=createCloudState({rpc}),remote=createSupabaseArchiveTransport({secret});
 await remote.assertPrivate();
 const archive=createBudgetedAuditArchive({rpc,state,remote,receiptRoot:path.join(root,'archive-receipts'),requestBytes:4096+2*Buffer.byteLength(secret),approvedNovemberRelease:true});
 const result=await stageAuditHandoff({root,sha,withBaseline:baseline==='--with-baseline',archive:{readObject:archive.readBounded}});
 console.log(JSON.stringify(result));
}
main().catch(error=>{
 console.error(JSON.stringify({status:'stage-blocked',reason:error.code==='AUDIT_BUDGET'?'allowance':'archive-or-validation'}));
 process.exitCode=1;
});
