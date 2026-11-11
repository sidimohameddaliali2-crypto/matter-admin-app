import {formatDubai} from './serviceTime';
export function historySummary(entry){
 const before=entry.before,after=entry.after||{};
 let label=String(entry.event||'Update').replaceAll('_',' ');
 if(entry.event==='work')label=after.status==='resolved'?'Resolved':!before?'Issue created':before.status==='resolved'||before.status==='non_customer'?'Issue reopened':after.currentActionCode==='followup_other'?'Follow-up updated':'Update recorded';
 else label=({create:'Issue created',non_customer_classified:'Type saved: '+(after.resolution?.outcomeLabel||(after.classification?.kind==='vendor'?'Vendor':after.classification?.kind==='spam'?'Spam':'Spam / Vendor')),assign:'Owner changed',followup:'Follow-up added',followup_update:'Follow-up updated',progress:'Update recorded',resolve:'Resolved',split_created:'Issue created',link_message:'Evidence linked'})[entry.event]||label;
 const changes=[];
 if(after.resolution&&entry.event==='work'&&after.status==='resolved')changes.push(after.resolution.outcomeLabel||'Outcome recorded');
 if(after.nextAction?.action&&(!before||before.nextAction?.action!==after.nextAction.action))changes.push('Next: '+after.nextAction.action);
 if(after.nextAction?.dueAt&&before?.nextAction?.dueAt!==after.nextAction.dueAt)changes.push('Check: '+formatDubai(after.nextAction.dueAt));
 if(after.waitingOn&&before?.waitingOn!==after.waitingOn)changes.push('Waiting for '+after.waitingOn);
 if(after.customerUpdateDueAt&&before?.customerUpdateDueAt!==after.customerUpdateDueAt)changes.push('Customer update: '+formatDubai(after.customerUpdateDueAt));
 return {label,changes};
}
