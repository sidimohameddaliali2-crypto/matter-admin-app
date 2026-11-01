export const currentStaffToken=(reduxToken,storedToken)=>reduxToken&&reduxToken===storedToken?reduxToken:null;
export function connectReportingWorkspace({getToken,fetchImpl=fetch}){
 return {
  async connect({signal}={}){
   const token=getToken();if(!token)throw Error('Staff sign-in required');
   const response=await fetchImpl('/api/reporting-ui/session',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal});
   if(!response.ok)throw Object.assign(Error(response.status===403?'Reports permission required':'Reporting connection unavailable. Retry shortly.'),{status:response.status});
   const data=await response.json();if(getToken()!==token||signal?.aborted)throw Error('Staff session changed');
   if(typeof data.frame!=='string'||!/^\/api\/reporting-ui\/(?:\?[^#]*)?$/.test(data.frame))throw Error('Invalid reporting frame');
   return data;
  },
  disconnect:()=>fetchImpl('/api/reporting-ui/session',{method:'DELETE',credentials:'same-origin',keepalive:true}).catch(()=>{})
 };
}
export function disconnectReportingWorkspace(){if(process.env.REACT_APP_REPORTING_WORKSPACE==='true')void fetch('/api/reporting-ui/session',{method:'DELETE',credentials:'same-origin',keepalive:true}).catch(()=>{});}
