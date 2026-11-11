// Hints warm an authenticated, exact-version image cache only. They never supply
// displayed rows, tiers or decisions; the current overlay remains authoritative.
export function addPreviewPhotoPrime(html,hints,url){
 if(!hints||hints.version!==1||!Array.isArray(hints.rows)||!/^[a-f0-9]{64}$/.test(hints.snapshot||''))return html;
 const p=url.searchParams,from=p.get('reportFrom'),to=p.get('reportTo');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||'')||[...p.keys()].some(k=>!['screen','reportFrom','reportTo','reportDates','report_population','view','tab'].includes(k))||!['warnings',null].includes(p.get('report_population')))return html;
 const first=hints.rows.find(r=>r.date>=from&&r.date<=to);if(!first)return html;
 const path='/api/reporting/photo/image?'+new URLSearchParams({record:first.key,snapshot:hints.snapshot});
 return html.replace('</head>','<script>void fetch('+JSON.stringify(path)+',{credentials:"same-origin",cache:"no-cache",headers:{"X-Report-Prefetch":"1"}}).then(r=>r.arrayBuffer()).catch(()=>{});</script></head>');
}
