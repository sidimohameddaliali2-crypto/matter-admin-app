import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MenuSelectionBrowser from './MenuSelectionBrowser';
global.IS_REACT_ACT_ENVIRONMENT = true;

test('401 customers remain searchable while only 50 cards render; search does not rerender the parent or retained rows', async () => {
  const customers = Array.from({ length: 401 }, (_, i) => ({ _id: String(i), firstName: `Person${i}`, lastName: 'Fixture', email: `person${i}@example.invalid`,
    selectedMeals: [{ mealName: 'Chosen meal', quantity: 2, remark: 'veg' }] }));
  const before = JSON.stringify(customers), seen = [], renderRow = jest.fn(customer => { seen.push(customer); return <button>{customer.firstName}</button>; });
  let renders = 0;
  const Parent = () => { renders++; return <MenuSelectionBrowser customers={customers} renderCustomer={renderRow} />; };
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  const search = async value => act(async () => { const input=node.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true})); });
  try {
    await act(async () => root.render(<Parent />));
    expect(renderRow).toHaveBeenCalledTimes(50);
    await search('Person4');
    expect(node.textContent).toContain('Person400');
    expect(node.textContent).not.toContain('Person399');
    expect(renders).toBe(1);
    expect(renderRow.mock.calls.filter(([customer]) => customer._id === '4')).toHaveLength(1);
    expect(seen.every(customer => customers.includes(customer))).toBe(true);
    expect(JSON.stringify(customers)).toBe(before);
    await search('');
    while (node.textContent.includes('Show 50 more customers')) await act(async () => [...node.querySelectorAll('button')].find(b=>b.textContent==='Show 50 more customers').click());
    expect(node.textContent).toContain('Showing 401 of 401');
    expect(seen.some(customer => customer._id === '400')).toBe(true);
  } finally { await act(async () => root.unmount()); node.remove(); }
});
