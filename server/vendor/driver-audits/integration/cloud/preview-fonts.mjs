import {createHash} from 'node:crypto';
// Keep exact font bytes and declarations. Let the browser request only used faces,
// instead of parsing every embedded font before it can request report data.
export function extractPreviewFonts(source){
 const assets=new Map();
 const html=source.replace(/data:font\/(woff2?|ttf|otf);base64,([A-Za-z0-9+/]+={0,2})/g,(_url,format,data)=>{
  const bytes=Buffer.from(data,'base64'),digest=createHash('sha256').update(bytes).digest('hex'),url='/report-assets/font-'+digest+'.'+format;
  assets.set(url,{bytes,mime:'font/'+format});return url;
 });
 return {html,asset:url=>{const value=assets.get(url);if(!value)throw Object.assign(Error('Unknown preview font'),{status:404});return value;}};
}
