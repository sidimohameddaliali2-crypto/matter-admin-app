import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import useKitchenCurrentScope, { KITCHEN_AUTO_SCOPE_KEY } from './useKitchenCurrentScope';

global.IS_REACT_ACT_ENVIRONMENT = true;
const active = { _id: 'active', isActive: true, isPublished: true, startDate: '2026-10-26', endDate: '2026-11-01' };
let root, container;
beforeEach(() => {
  localStorage.clear(); jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-28T08:00:00Z'));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); });

function Harness({ menus, prepared }) {
  const [menuId, setMenu] = useState(''), [date, setDate] = useState('');
  useEffect(() => { setDate(''); }, [menuId]);
  const mode = useKitchenCurrentScope({ menus, menuId, date, onMenu: id => { setDate(''); setMenu(id); }, onDate: setDate });
  useEffect(() => { if (menuId && date) prepared(menuId, date); }, [menuId, date, prepared]);
  return <><button onClick={() => mode.setEnabled(!mode.enabled)}>Toggle</button><button onClick={() => setDate('2026-10-29')}>Other day</button><output>{menuId}|{date}</output><p>{mode.message}</p></>;
}

test('opting in remembers the choice and prepares today once, after the menu reset, while still allowing manual dates', async () => {
  const prepared = jest.fn();
  await act(async () => root.render(<Harness menus={[active]} prepared={prepared} />));
  expect(prepared).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button').click());
  expect(container.querySelector('output').textContent).toBe('active|2026-10-28');
  expect(prepared.mock.calls).toEqual([['active', '2026-10-28']]);
  expect(localStorage.getItem(KITCHEN_AUTO_SCOPE_KEY)).toBe('true');
  await act(async () => container.querySelectorAll('button')[1].click());
  expect(container.querySelector('output').textContent).toBe('active|2026-10-29');
  expect(prepared.mock.calls).toEqual([['active', '2026-10-28'], ['active', '2026-10-29']]);
});

test('a later visit starts automatically, and overlapping menus never start a guessed preparation', async () => {
  localStorage.setItem(KITCHEN_AUTO_SCOPE_KEY, 'true');
  const prepared = jest.fn();
  await act(async () => root.render(<Harness menus={[active, { ...active, _id: 'other' }]} prepared={prepared} />));
  expect(prepared).not.toHaveBeenCalled();
  expect(container.textContent).toContain('More than one');
  await act(async () => root.render(<Harness menus={[active]} prepared={prepared} />));
  expect(prepared.mock.calls).toEqual([['active', '2026-10-28']]);
});
