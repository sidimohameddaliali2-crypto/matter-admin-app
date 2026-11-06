import { ingestServiceBatch } from '../services/customerServiceCapture.js';
import { captureRange } from '../services/customerServiceCaptureFormat.js';

// Optional normalized reconciliation feed. No provider URL, access grant or schedule is invented.
export function startCustomerServiceSync() {
  if(process.env.CUSTOMER_SERVICE_CAPTURE_ENABLED!=='true'||!process.env.CUSTOMER_SERVICE_FEED_URL) return null;
  let running=false;
  const run=async()=>{
    if(running) return;
    running=true;
    try {
      const url=new URL(process.env.CUSTOMER_SERVICE_FEED_URL);
      if(url.protocol!=='https:') throw new Error('Feed requires HTTPS');
      const response=await fetch(url,{headers:process.env.CUSTOMER_SERVICE_FEED_TOKEN?{Authorization:`Bearer ${process.env.CUSTOMER_SERVICE_FEED_TOKEN}`}:{},signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!response.ok) throw new Error('Feed unavailable');
      const length=Number(response.headers.get('content-length')||0);
      if(length>5*1024*1024) throw new Error('Feed exceeds 5 MB');
      const text=await response.text();
      if(Buffer.byteLength(text)>5*1024*1024) throw new Error('Feed exceeds 5 MB');
      const batch=JSON.parse(text);
      await ingestServiceBatch({...batch,...captureRange(batch),actor:null});
    } catch {
      // Never log message content, customer identity, credential-bearing URLs or tokens.
      console.error('Customer service reconciliation failed; coverage is not advanced.');
    } finally { running=false; }
  };
  const interval=Number(process.env.CUSTOMER_SERVICE_SYNC_MINUTES||30);
  if(!Number.isFinite(interval)||interval<5||interval>1440) { console.error('Invalid customer service sync interval; scheduler disabled.');return null; }
  const timer=setInterval(run,interval*60000);timer.unref();return timer;
}
