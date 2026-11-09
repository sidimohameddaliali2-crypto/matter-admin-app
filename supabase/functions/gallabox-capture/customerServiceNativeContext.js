// Recover source presentation fields without rewriting the original message body.
export function nativeContentFromWhatsapp(wa) {
 if(!wa||wa.type==='text')return null;
 const kind=wa.type,template=wa.template;
 if(kind==='template')return {kind,text:template?.body,headerText:typeof template?.header?.text==='string'?template.header.text:undefined,buttons:Array.isArray(template?.buttons)?template.buttons.map(b=>typeof b==='string'?b:b?.text||b?.title).filter(Boolean):undefined};
 if(kind==='reaction')return {kind,emoji:wa.reaction?.emoji,targetId:wa.reaction?.message_id,text:wa.reaction?.text};
 if(kind==='button')return {kind,text:wa.button?.text};
 if(kind==='interactive')return {kind,text:wa.interactive?.button_reply?.title||wa.interactive?.list_reply?.title||wa.interactive?.body?.text,buttons:wa.interactive?.action?.buttons?.map(b=>b?.reply?.title).filter(Boolean)};
 if(kind==='contacts')return {kind,contacts:Array.isArray(wa.contacts)?wa.contacts.map(c=>({name:c?.name?.formattedName||c?.name?.formatted_name,phones:c?.phones?.map(p=>p?.phone)})):[]};
 return {kind,text:wa[kind]?.caption};
}
export function sanitizeNativeContent(value) {
 if(!value||typeof value.kind!=='string'||!/^[a-zA-Z0-9_-]{1,60}$/.test(value.kind))return null;
 const out={kind:value.kind};
 for(const[key,max]of Object.entries({text:20000,headerText:1000,emoji:32,targetId:300}))if(typeof value[key]==='string')out[key]=value[key].slice(0,max);
 if(Array.isArray(value.contacts))out.contacts=value.contacts.slice(0,20).map(c=>({name:typeof c?.name==='string'?c.name.slice(0,200):'',phones:Array.isArray(c?.phones)?c.phones.filter(p=>typeof p==='string').slice(0,10).map(p=>p.slice(0,100)):[]}));
 if(Array.isArray(value.buttons))out.buttons=value.buttons.filter(x=>typeof x==='string').slice(0,10).map(x=>x.slice(0,300));
 return out;
}
