import { useEffect, useRef, useState } from 'react';
import { currentKitchenMenu, kitchenMenuAccess, kitchenToday } from './kitchenDayScope';
import { getDateKey } from './kitchenData';

export const KITCHEN_AUTO_SCOPE_KEY = 'matter:kitchen:auto-current';
const readPreference = () => { try { return localStorage.getItem(KITCHEN_AUTO_SCOPE_KEY) === 'true'; } catch { return false; } };

export default function useKitchenCurrentScope({ menus, menuId, date, onMenu, onDate, lockMenu = false }) {
  const [preference, setEnabled] = useState(readPreference);
  const enabled = lockMenu || preference;
  const [, refreshClock] = useState(0);
  // Read the real clock on every render as well as waking at day boundaries:
  // a suspended tab may miss its timer before a staff member switches menus.
  const now = new Date();
  const today = kitchenToday(now);
  const applied = useRef(null), pending = useRef(null);
  const callbacks = useRef({ onMenu, onDate });
  callbacks.current = { onMenu, onDate };
  const access = kitchenMenuAccess(menus, now, today);
  const choice = lockMenu ? { menu: access.availableMenus.find(menu => String(menu._id) === menuId) || access.defaultMenu,
    ambiguous: access.currentAmbiguous } : currentKitchenMenu(menus, today);
  const targetDate = choice.menu && getDateKey(choice.menu.startDate) > today ? getDateKey(choice.menu.startDate) : today;
  const nextDubaiMidnight = Date.parse(`${today}T00:00:00Z`) + 24 * 3600000 - 240 * 60000;
  const nextClockChange = Math.min(access.nextChangeAt, nextDubaiMidnight);
  useEffect(() => {
    if (!lockMenu) return undefined;
    const timer = setTimeout(() => refreshClock(value => value + 1), Math.max(1, nextClockChange - Date.now()));
    return () => clearTimeout(timer);
  }, [lockMenu, nextClockChange]);
  useEffect(() => {
    if (!lockMenu) try { localStorage.setItem(KITCHEN_AUTO_SCOPE_KEY, String(enabled)); } catch { /* Manual selection still works. */ }
    if (!enabled) { applied.current = null; pending.current = null; return; }
    if (!choice.menu) {
      if (lockMenu) {
        applied.current = null;
        pending.current = null;
        if (menuId) callbacks.current.onMenu('');
      }
      return;
    }
    const id = String(choice.menu._id);
    if (applied.current === id && (!lockMenu || menuId === id)) return; // Allow browsing a different date manually.
    if (menuId !== id) {
      applied.current = null;
      pending.current = id;
      callbacks.current.onMenu(id);
      return;
    }
    // This effect runs after the page's menu-reset effect, so its date is not
    // immediately cleared again when automatic mode picks a different menu.
    if (pending.current === id || date !== targetDate) callbacks.current.onDate(targetDate);
    pending.current = null;
    applied.current = id;
  }, [enabled, lockMenu, choice.menu?._id, menuId, date, targetDate]);
  return { enabled, availableMenus: access.availableMenus, nextMenuId: access.nextMenuId,
    setEnabled: lockMenu ? () => {} : setEnabled, message: lockMenu && access.scheduledAmbiguous && !access.currentAmbiguous
    ? 'More than one scheduled menu starts next week. Resolve the overlap in Menu Management to open next week.'
    : enabled && (lockMenu || menus.length) && !choice.menu
    ? choice.ambiguous ? `More than one published active menu covers today. ${lockMenu ? 'Resolve the overlap in Menu Management to open Kitchen List.' : 'Choose the menu and date manually.'}`
      : `No published active menu covers today. ${lockMenu ? 'Activate the current menu in Menu Management to open Kitchen List.' : 'Choose a menu and date manually.'}` : '' };
}
