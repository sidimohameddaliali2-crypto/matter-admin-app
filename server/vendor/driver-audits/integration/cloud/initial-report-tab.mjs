// The archived renderer validates the URL against default tabs before authored
// tabs register. Honour the requested Matter tab immediately to avoid starting
// thirty unrelated data reads during that first render. No layout/data mutation.
export function initializeReportTab(html){
 const original='(0,v.useState)(()=>h.tab??(p.tabs??GK)[0].id)';
 const count=html.split(original).length-1;
 if(count===0)return html; // Different renderer: retain its original behaviour.
 if(count!==1)throw Error('Ambiguous report tab initializer');
 const guard="Ce.some(({id:e})=>e===Te)||Ee(Ce[0].id)},[Te,Ce])";
 if(html.split(guard).length===2)html=html.replace(guard,"Ze&&(Ce.some(({id:e})=>e===Te)||Ee(Ce[0].id))},[Te,Ce,Ze])");
 return html.replace(original,'(0,v.useState)(()=>(new URLSearchParams(location.search).get("tab")==="mirror"?"mirror":h.tab)??(p.tabs??GK)[0].id)');
}
