export const normalizeContactEmail=value=>typeof value==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())?value.trim().toLowerCase():'';
export function normalizeContactPhone(value){
 if(typeof value!=='string'&&typeof value!=='number')return '';
 const raw=String(value).trim();if(!/^[+\d\s().-]+$/.test(raw))return '';
 let digits=raw.replace(/\D/g,'');if(digits.startsWith('00'))digits=digits.slice(2);
 // Matter's UAE local mobile format is normalized explicitly; no suffix match.
 if(/^05\d{8}$/.test(digits))digits='971'+digits.slice(1);
 // UAE country code is already explicit; the national trunk 0 is omitted internationally.
 // Never add a country code to a bare nine-digit value.
 if(/^97105\d{8}$/.test(digits))digits='971'+digits.slice(4);
 return /^[1-9]\d{7,14}$/.test(digits)?digits:'';
}
