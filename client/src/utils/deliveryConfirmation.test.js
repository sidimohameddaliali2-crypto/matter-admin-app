import {requireDeliveryConfirmation} from './deliveryConfirmation';
test('only matching persisted id and requested status confirm completion',()=>{
 const delivery={_id:'d1',status:'delivered'};
 expect(requireDeliveryConfirmation({success:true,delivery},'d1','delivered')).toBe(delivery);
 for(const data of [{success:true},{success:true,delivery:{_id:'other',status:'delivered'}},
   {success:true,delivery:{_id:'d1',status:'assigned'}},{success:false,delivery}]){
  expect(()=>requireDeliveryConfirmation(data,'d1','delivered')).toThrow();
 }
});
