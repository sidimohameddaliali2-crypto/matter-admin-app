const labels={
 snapshot:'Verified snapshot. Automatic updates have not started.',
 checking:'Checking newly saved evidence.',
 pending:'New evidence is pending.',
 ready:'Verified against the latest saved evidence.',
 failed:'Sync needs attention. The last verified audit is still available.',
 'capacity-blocked':'Sync is waiting for storage capacity. The last verified audit is still available.',
 'budget-deferred':'Sync is waiting for the existing allowance. The last verified audit is still available.',
};

const safeJson=value=>JSON.stringify(value).replaceAll('<','\\u003c');

export function addDriverAuditSyncStatus(html,initial){
 const script=`<script>(()=>{const labels=${safeJson(labels)};let displayed=false;const show=(data)=>{
  if(!data||!Object.hasOwn(labels,data.status))return false;
  const date=(value)=>{if(!value)return 'Unavailable';const parsed=new Date(value);return Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Dubai'}).format(parsed)+' Dubai':'Unavailable';};
  const banner=document.getElementById('matter-audit-sync-status');
  if(banner){const text='Latest saved delivery capture '+date(data.latestCaptureAt)+' · Visible audit cutoff '+date(data.visibleCutoffAt)+' · '+labels[data.status];if(banner.textContent!==text)banner.textContent=text;displayed=true;}
  return displayed;
 };
 const unavailable=()=>{if(!displayed){const banner=document.getElementById('matter-audit-sync-status');if(banner)banner.textContent='Audit sync status is temporarily unavailable.';}};
 show(${safeJson(initial)});
 const original=window.fetch;
 window.fetch=function(input,options){
  const response=original.call(this,input,options);
  try{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
   if(url.origin===location.origin&&url.pathname==='/api/reporting/status'){
    void response.then(result=>result.ok?result.clone().json():null).then(value=>{if(!show(value?.auditSync))unavailable();}).catch(unavailable);
   }
  }catch{}
  return response;
 };
 })();</script>`;
 return html.replace(/<body(?:\s[^>]*)?>/i,tag=>tag+'<aside id="matter-audit-sync-status" role="status" style="padding:6px 16px;font:12px system-ui">Loading audit sync status…</aside>'+script);
}
