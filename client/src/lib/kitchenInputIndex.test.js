import { enrichSelectionsWithNutrition } from './kitchenData';

test('401 inputs are indexed once instead of scanning 401 inputs for each customer; choices and remarks are identical', async () => {
  let identityReads=0;
  const rows=Array.from({length:401},(_,i)=>({matterCustomerId:String(i),email:`person${i}@example.invalid`,selectedMeals:[{mealName:'Chosen chicken',quantity:2,remark:'veg'}]}));
  const inputs=rows.map((row,i)=>({get customer_id(){identityReads++;return String(i);},customer_email:row.email,subscription_id:String(i),
    customer_name:`Matter Person ${i}`,source_fetched_at:new Date().toISOString(),plan_name:'Custom',meal_frequency:2,breakfast_included:false,snacks_per_day:1,
    macros:{carbohydrates:140,protein:120,fat:50},active_delivery_dates:['2026-11-06'],exclusions:['Soy']}));
  const before=JSON.stringify(rows),api={get:jest.fn()},onEach=jest.fn();
  const output=await enrichSelectionsWithNutrition(api,rows,{current:new Map()},{matterInputs:inputs,onEach});
  expect(api.get).not.toHaveBeenCalled();expect(onEach).toHaveBeenCalledTimes(401);
  expect(identityReads).toBeLessThan(401*10); // Original scan: at least 401*401 reads.
  expect(output).toHaveLength(401);
  output.forEach((row,i)=>{expect(row.selectedMeals).toBe(rows[i].selectedMeals);expect(row.targetMacros).toEqual({C:140,P:120,F:50});expect(row.dietaryRestrictions).toEqual(['Soy']);});
  expect(JSON.stringify(rows)).toBe(before);
});

test('expiration while workers wait still requires a fresh verification', async () => {
  const start=Date.now(),now=jest.spyOn(Date,'now').mockReturnValue(start);
  const rows=[{matterCustomerId:'first',email:'first@example.invalid'},{matterCustomerId:'second',email:'second@example.invalid'}];
  const inputs=[{customer_id:'second',customer_email:rows[1].email,subscription_id:'sub',source_fetched_at:new Date(start-179999).toISOString()}];
  const api={get:jest.fn(async()=>{now.mockReturnValue(start+5);return{data:{success:true,data:null}}})};
  try{await enrichSelectionsWithNutrition(api,rows,{current:new Map()},{matterInputs:inputs,concurrency:1});expect(api.get).toHaveBeenCalledTimes(2);}finally{now.mockRestore();}
});
