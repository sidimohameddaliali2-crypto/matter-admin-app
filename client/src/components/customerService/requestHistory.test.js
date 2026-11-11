import {historySummary} from './requestHistory';
test('guided history distinguishes registration, followup, completion and reopening',()=>{
 expect(historySummary({event:'work',before:null,after:{status:'open'}}).label).toBe('Issue created');
 expect(historySummary({event:'work',before:{status:'open'},after:{status:'waiting',currentActionCode:'followup_other',waitingOn:'Delivery'}})).toEqual({label:'Follow-up updated',changes:['Waiting for Delivery']});
 expect(historySummary({event:'work',before:{status:'waiting'},after:{status:'resolved',resolution:{outcomeLabel:'Day credit applied'}}})).toEqual({label:'Resolved',changes:['Day credit applied']});
 expect(historySummary({event:'work',before:{status:'resolved'},after:{status:'open'}}).label).toBe('Issue reopened');
});
test('the visible change summary preserves next step and source event distinctions',()=>{
 expect(historySummary({event:'work',before:{nextAction:{action:'Old check'}},after:{status:'open',nextAction:{action:'New check',dueAt:'2026-11-11T06:00:00Z'},customerUpdateDueAt:'2026-11-11T06:30:00Z'}}).changes).toEqual(['Next: New check','Check: 11 Nov 2026, 10:00','Customer update: 11 Nov 2026, 10:30']);
 expect(historySummary({event:'provider_closed'}).label).toBe('provider closed');
});
