import {isDay,shiftDay} from '../../app/src/content/dashboard/operations-model.mjs';
// A saved lookup examines only the published assessment. Raw archived captures are
// inputs to an explicit candidate refresh, never substitutes for completed work.
export function completedReport(app,head,{from,to=from,reportId}={},today){
 if(!isDay(from)||!isDay(to)||from>to||to>today)throw Object.assign(Error('Choose a valid saved delivery range through today.'),{status:400});
 if(reportId&&reportId!==head?.manifest?.sha256)throw Object.assign(Error('Saved report identity changed'),{status:409});
 const savedDays=new Set(Object.keys(app.matter.validatedReporting.coverage||{}));
 for(const row of app.queries.reporting_validated_deliveries?.rows||[])savedDays.add(row.date);
 const missingDays=[];for(let day=from;day<=to;day=shiftDay(day,1))if(!savedDays.has(day))missingDays.push(day);
 return {status:missingDays.length?'unavailable':'saved',reportId:head.manifest.sha256,reportHash:app.matter.validatedReporting.snapshotHash,from,to,missingDays};
}
export function publicationAdmission(){
 let active=false;
 return {enter(){if(active)throw Object.assign(Error('Publication active'),{status:409});active=true;let released=false;return ()=>{if(!released){active=false;released=true;}};},assertGeneration(expected,current){if(expected!==current)throw Object.assign(Error('Stale publication'),{status:409});}};
}
// Processing receipts append independently; immutable content never encodes which
// duplicate source event happened to be consumed first.
export function contentHead({processed,...head}){return head;}
