import React from 'react';

export const REQUEST_TYPE_CHOICES=[{value:'complaint',label:'Complaint'},{value:'inquiry',label:'Inquiry'},{value:'non_customer',label:'Spam / Vendor',values:['spam','vendor','non_customer']}];
export default function RequestTypeButtons({options=REQUEST_TYPE_CHOICES,value,onChange}){
 return <fieldset className="cs-type-buttons" aria-label="Type"><legend className="cs-sr-only">Type</legend>{options.map(option=>{
  const selected=(option.values||[option.value]).includes(value);
  return <button type="button" key={option.value} aria-pressed={selected} onClick={()=>onChange(selected?value:option.value)}>{option.label}</button>;
 })}</fieldset>;
}
