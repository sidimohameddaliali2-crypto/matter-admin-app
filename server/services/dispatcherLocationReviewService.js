import crypto from 'node:crypto';
import { resolveMatterDeliveryAddress } from './matterSubscriptionContract.js';
import { applyZoneRules } from '../config/zoneRules.js';
export const REVIEW_CATEGORIES = ['location_incorrect','missing_information','gps_wrong'];
export function newSubscriptionCustomers(rows) {
  const subscriptions=rows.filter(s=>String(s.customer_type||'').trim().toLowerCase()==='new');
  if(subscriptions.some(s=>s.customer_id==null||s.subscription_id==null))throw new Error('New customer identity is missing from the subscription source.');
  const unique=[...new Map(subscriptions.map(s=>[String(s.subscription_id),s])).values()];
  return {subscriptions:unique,count:new Set(unique.map(s=>String(s.customer_id))).size};
}
export function subscriptionLocation(s) {
  const resolution=resolveMatterDeliveryAddress(s.customer_addresses), a=resolution.address;
  const raw=a?.coordinates, valid=typeof raw?.lat==='number'&&typeof raw?.lng==='number'&&Number.isFinite(raw.lat)&&Number.isFinite(raw.lng)&&Math.abs(raw.lat)<=90&&Math.abs(raw.lng)<=180&&(raw.lat!==0||raw.lng!==0);
  const snapshot={customerId:String(s.customer_id),subscriptionId:String(s.subscription_id),addressId:a?.id==null?null:String(a.id),resolution:resolution.reason,address:a?Object.fromEntries(['label','emirate','area','street','building','unit','floor','additional_details','category','status'].map(k=>[k,a[k]??null])):null,pin:valid?{lat:raw.lat,lng:raw.lng}:null};
  return {customerId:snapshot.customerId,subscriptionId:snapshot.subscriptionId,customerName:s.name||'Unnamed customer',customerType:s.customer_type,location:a?[a.building,a.unit,a.floor,a.street,a.area,a.emirate].filter(Boolean).join(', '):'',zone:a?applyZoneRules({zone:a.area,city:a.emirate})||'':'',pin:snapshot.pin,addressDetails:snapshot.address,resolution:resolution.reason,snapshot,revision:crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
}
export function validateLocationReview(body) {
  if(!body||typeof body.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)||typeof body.revision!=='string'||!/^[0-9a-f]{64}$/.test(body.revision))return 'A valid request ID and location revision are required.';
  if(!['confirm','feedback'].includes(body.action))return 'Choose confirmation or feedback.';
  if(body.action==='feedback'&&(!REVIEW_CATEGORIES.includes(body.category)||typeof body.issue!=='string'||!body.issue.trim()||body.issue.length>2000))return 'Choose a valid issue type and describe the issue (up to 2,000 characters).';
  if(body.action==='confirm'&&(body.category||body.issue))return 'Confirmation cannot contain feedback.';
  return null;
}
