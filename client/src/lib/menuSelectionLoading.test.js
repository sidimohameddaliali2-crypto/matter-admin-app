import { loadMenuSelectionSummaries, loadMenuSelectionDetails } from './menuSelectionLoading';

test('before/after: listing 401 saved selections needs zero nutrition calls; opening one verifies only that customer', async () => {
  const rows = Array.from({ length: 401 }, (_, i) => ({ _id: String(i), matterCustomerId: String(i), email: `person${i}@example.invalid`,
    firstName: 'Saved Matter name', selectedMeals: [{ mealName: 'Chosen dish', quantity: 2, remark: 'veg', isAutoAssigned: false }] }));
  const before=JSON.stringify(rows);
  const api={get:jest.fn(async (url, config) => url.endsWith('/selections') ? {data:{success:true,data:rows}}
    : {data:{success:true,data:{customer_id:config.params.customerId,customer_email:config.params.email,subscription_id:'sub',customer_name:'Current Matter name',exclusions:[]}}})};
  const summaries=await loadMenuSelectionSummaries(api,'menu');
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(summaries).toBe(rows);
  const [detail]=await loadMenuSelectionDetails(api,[summaries[400]]);
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(detail.firstName).toBe('Current');
  expect(detail.selectedMeals).toBe(rows[400].selectedMeals);
  expect(JSON.stringify(rows)).toBe(before);
});
