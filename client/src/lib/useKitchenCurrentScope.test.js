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

function Harness({ menus, prepared, lockMenu = false }) {
  const [menuId, setMenu] = useState(''), [date, setDate] = useState('');
  useEffect(() => { setDate(''); }, [menuId]);
  const mode = useKitchenCurrentScope({ menus, menuId, date, lockMenu, onMenu: id => { setDate(''); setMenu(id); }, onDate: setDate });
  useEffect(() => { if (menuId && date) prepared(menuId, date); }, [menuId, date, prepared]);
  return <><button onClick={() => mode.setEnabled(!mode.enabled)}>Toggle</button><button onClick={() => setDate('2026-10-29')}>Other day</button><select value={menuId} onChange={event => { setDate(''); setMenu(event.target.value); }}><option value="" />{mode.availableMenus.map(menu => <option key={menu._id} value={menu._id}>{menu._id}</option>)}</select><output>{menuId}|{date}</output><p>{mode.message}</p></>;
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

test('locked mode defaults on despite a saved off preference, keeps manual dates and does not change Counting preference', async () => {
  localStorage.setItem(KITCHEN_AUTO_SCOPE_KEY, 'false');
  const prepared = jest.fn();
  await act(async () => root.render(<Harness menus={[active]} prepared={prepared} lockMenu />));
  expect(prepared.mock.calls).toEqual([['active', '2026-10-28']]);
  await act(async () => container.querySelector('button').click());
  await act(async () => container.querySelectorAll('button')[1].click());
  expect(container.querySelector('output').textContent).toBe('active|2026-10-29');
  expect(localStorage.getItem(KITCHEN_AUTO_SCOPE_KEY)).toBe('false');
});

test('locked mode blocks ambiguous or missing active menus instead of offering manual menu switching', async () => {
  const prepared = jest.fn();
  await act(async () => root.render(<Harness menus={[active, { ...active, _id: 'overlap' }]} prepared={prepared} lockMenu />));
  expect(prepared).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Resolve the overlap in Menu Management');
  await act(async () => root.render(<Harness menus={[active]} prepared={prepared} lockMenu />));
  expect(prepared).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Harness menus={[{ ...active, isActive: false }]} prepared={prepared} lockMenu />));
  expect(container.querySelector('output').textContent).toBe('|');
  expect(container.textContent).toContain('Activate the current menu in Menu Management');
});

test('Friday 15:00 unlocks next week in an already-open page; switching menus picks a valid date without snapping back', async () => {
  jest.setSystemTime(new Date('2026-10-30T10:59:59Z'));
  const next = { ...active, _id: 'scheduled', isPublished: false, startDate: '2026-11-02', endDate: '2026-11-08' };
  const prepared = jest.fn();
  await act(async () => root.render(<Harness menus={[active, next]} prepared={prepared} lockMenu />));
  expect(container.querySelectorAll('option')).toHaveLength(2);
  expect(prepared.mock.calls).toEqual([['active', '2026-10-30']]);
  await act(async () => jest.advanceTimersByTime(1000));
  expect(container.querySelectorAll('option')).toHaveLength(3);
  expect(prepared).toHaveBeenCalledTimes(1);
  await act(async () => {
    container.querySelector('select').value = 'scheduled';
    container.querySelector('select').dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('output').textContent).toBe('scheduled|2026-11-02');
  expect(prepared.mock.calls.at(-1)).toEqual(['scheduled', '2026-11-02']);
  await act(async () => {
    container.querySelector('select').value = 'active';
    container.querySelector('select').dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('output').textContent).toBe('active|2026-10-30');
});
