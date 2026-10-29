import { useEffect, useRef, useState } from 'react';
import { currentKitchenMenu, kitchenToday } from './kitchenDayScope';

export const KITCHEN_AUTO_SCOPE_KEY = 'matter:kitchen:auto-current';
const readPreference = () => { try { return localStorage.getItem(KITCHEN_AUTO_SCOPE_KEY) === 'true'; } catch { return false; } };

export default function useKitchenCurrentScope({ menus, menuId, date, onMenu, onDate }) {
  const [enabled, setEnabled] = useState(readPreference);
  const [today] = useState(kitchenToday);
  const applied = useRef(null), pending = useRef(null);
  const callbacks = useRef({ onMenu, onDate });
  callbacks.current = { onMenu, onDate };
  const choice = currentKitchenMenu(menus, today);
  useEffect(() => {
    try { localStorage.setItem(KITCHEN_AUTO_SCOPE_KEY, String(enabled)); } catch { /* Manual selection still works. */ }
    if (!enabled) { applied.current = null; pending.current = null; return; }
    if (!choice.menu) return;
    const id = String(choice.menu._id);
    if (applied.current === id) return; // Allow browsing a different date manually.
    if (menuId !== id) {
      pending.current = id;
      callbacks.current.onMenu(id);
      return;
    }
    // This effect runs after the page's menu-reset effect, so its date is not
    // immediately cleared again when automatic mode picks a different menu.
    if (pending.current === id || date !== today) callbacks.current.onDate(today);
    pending.current = null;
    applied.current = id;
  }, [enabled, choice.menu?._id, menuId, date, today]);
  return { enabled, setEnabled, message: enabled && menus.length && !choice.menu
    ? choice.ambiguous ? 'More than one published active menu covers today. Choose the menu and date manually.'
      : 'No published active menu covers today. Choose a menu and date manually.' : '' };
}
