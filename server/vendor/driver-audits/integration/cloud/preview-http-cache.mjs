import {createHash} from 'node:crypto';
// Revalidation is mandatory: no shared cache and no offline/stale authorization.
export function privateEvidenceHeaders(bytes){return {'Cache-Control':'private, no-cache, must-revalidate',ETag:'"'+createHash('sha256').update(bytes).digest('hex')+'"',Vary:'Cookie, Accept-Encoding'};}
export function matchesEvidenceTag(header,etag){return typeof header==='string'&&header.split(',').some(value=>value.trim()===etag||value.trim()==='W/'+etag);}
export function installPrivateEvidenceCache(){
 const original=window.fetch.bind(window);
 window.fetch=(input,init)=>{const request=new Request(input,init),url=new URL(request.url);const immutable=/^\/report-data\/(?:snapshot|detail|history|query|archive)-[a-f0-9]{64}\.json$/.test(url.pathname),photo=url.pathname==='/api/reporting/photo/image'&&url.searchParams.getAll('record').length===1&&url.searchParams.getAll('snapshot').length===1&&/^[a-f0-9]{64}$/.test(url.searchParams.get('snapshot')||'');
  return original(request.method==='GET'&&url.origin===location.origin&&(immutable||photo||url.pathname==='/api/reporting/evidence-overlay')?new Request(request,{cache:'no-cache'}):request);
 };
}
export function addPrivateEvidenceCache(html){if(html.split('</head>').length!==2)throw Error('Renderer unavailable');return html.replace('</head>','<script>('+installPrivateEvidenceCache.toString()+')();</script></head>');}
