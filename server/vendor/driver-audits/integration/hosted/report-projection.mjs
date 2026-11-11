import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function mergeCapture(app,snapshot,engine){
 if(snapshot.kind!=='matter-api-mirror-v1'||snapshot.receipt?.snapshotComplete!==true||!Array.isArray(snapshot.rows)||snapshot.rows.length!==snapshot.receipt.rowCount||snapshot.rows.length!==snapshot.receipt.uniqueCount||new Set(snapshot.rows.map(r=>r.id)).size!==snapshot.rows.length||snapshot.snapshotHash!==hash({day:snapshot.day,rows:snapshot.rows,locations:snapshot.locations}))throw Error('Complete verified source capture required');
 const prior=app.matter.previewCapturesByDay?.[snapshot.day]||app.matter.validatedReporting?.sources?.[snapshot.day];
 const priorObservedAt=prior?.observedAt||prior?.deliveryObservedAt;
 if(priorObservedAt&&Date.parse(snapshot.deliveryObservedAt)<Date.parse(priorObservedAt))return app;
 if(priorObservedAt&&Date.parse(snapshot.deliveryObservedAt)===Date.parse(priorObservedAt)&&prior.snapshotHash&&prior.snapshotHash!==snapshot.snapshotHash)throw Error('Conflicting capture at the same source time');
 if(priorObservedAt&&Date.parse(snapshot.deliveryObservedAt)===Date.parse(priorObservedAt)&&prior.snapshotHash===snapshot.snapshotHash)return app;
 const id='reporting_validated_deliveries',before=app.queries[id]?.rows||[],currentIds=new Set(snapshot.rows.map(r=>snapshot.day+'/'+r.id));
 const omitted=before.filter(r=>r.date===snapshot.day&&!currentIds.has(r.key));
 const input=omitted.length?{...app,queries:{...app.queries,[id]:{...app.queries[id],rows:before.filter(r=>!omitted.includes(r))}}}:app;
 const meta=app.matter.validatedReporting;
 const report=engine.generateFreshReport(snapshot,{windowHours:3,rules:meta.rules,packageSha256:meta.packageSha256,truckoomSources:app.queries.reporting_truckoom_sources?.rows||[]});
 let next=engine.installFreshReport(input,report);const rows=[...(next.queries[id]?.rows||[]).map(r=>r.date===snapshot.day&&currentIds.has(r.key)?{...r,sourcePresence:'present',sourceLastCheckedAt:snapshot.deliveryObservedAt}:r),...omitted.map(r=>({...r,sourcePresence:'absent-from-latest-capture',sourceLastCheckedAt:snapshot.deliveryObservedAt}))].sort((a,b)=>a.key.localeCompare(b.key));
 next={...next,queries:{...next.queries,[id]:{...next.queries[id],rows}},matter:{...next.matter,validatedReporting:{...next.matter.validatedReporting,coverage:{...next.matter.validatedReporting.coverage,...report.coverage},sources:{...next.matter.validatedReporting.sources,...(report.source?{[snapshot.day]:report.source}:{})},snapshotHash:hash(rows.map(r=>[r.key,r.assessmentHash])),latestFreshDay:snapshot.day},previewCapturesByDay:{...app.matter.previewCapturesByDay,[snapshot.day]:{observedAt:snapshot.deliveryObservedAt,snapshotHash:snapshot.snapshotHash}},previewSource:{day:snapshot.day,observedAt:snapshot.deliveryObservedAt,observedRecords:snapshot.rows.length,retainedAbsent:omitted.length,atomic:false,fullEventHistory:false}}};
 const dayCoverage=next.matter.validatedReporting.coverage[snapshot.day];
 if(dayCoverage)next.matter.validatedReporting.coverage[snapshot.day]={...dayCoverage,sourceRecords:snapshot.rows.length,retainedAbsent:omitted.length,records:snapshot.rows.length+omitted.length};
 // Browsing historical reporting must not replace the newer operations day.
 if(!app.matter.apiMirror?.day||snapshot.day>=app.matter.apiMirror.day)next=engine.installApiSnapshot(next,snapshot);
 return {...next,buildStatus:'complete'};
}
export function bindReportManifest(html,prior,next){
 if(!/^[a-f0-9]{64}$/.test(prior.sha256)||!/^[a-f0-9]{64}$/.test(next.sha256))throw Error('Invalid report manifest');
 const token='report-data/snapshot-'+prior.sha256+'.json';if(!html.includes(token))throw Error('Pinned renderer manifest not found');
 // The immutable renderer contains this data digest in its path and integrity field.
 const matches=html.split(prior.sha256).length-1;if(matches!==2)throw Error('Unexpected renderer binding count');
 return html.replaceAll(prior.sha256,next.sha256);
}
