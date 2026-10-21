import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { groupExclusions, exclusionMatchesAny, exclusionMatchesTerm, allergenMatchesAny } from '../../constants/exclusionList';
import { toSentenceCase } from '../../utils/textFormat';
import MatterLogo from './MatterLogo';
import SkipPauseCalendarModal from './SkipPauseCalendarModal';
import {
  DEMO_ACCOUNTS,
  DEMO_DAYS,
  DEMO_MEALS,
  DEMO_MENU_NAME,
  DEMO_MENU_RANGE,
  DEMO_MONTHS,
  DEMO_WEEK_START,
} from './demoData';
import './menuSelectionLink.css';

/* ------------------------------------------------------------------ helpers */

const DAYS = DEMO_DAYS;
const MONTHS = DEMO_MONTHS;
const COURSES = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'main', label: 'Main Meal' },
];
const BAG = {
  breakfast: { bg: 'var(--color-accent-2-200)', fg: 'var(--color-accent-2-900)' },
  main: { bg: 'var(--color-accent-200)', fg: 'var(--color-accent-800)' },
};

const toDateKey = (value) => {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const dateFromKey = (key) => new Date(`${key}T00:00:00`);

const fmtDayLong = (key) => {
  const d = dateFromKey(key);
  if (Number.isNaN(d.getTime())) return key;
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

const fmtShort = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Whether a delivery day's selection deadline (deliveryDate - daysBefore
// calendar days, at deadlineTime, local time) has passed. Pure — no React
// state — so it can be used both from the render-time day-lock check and
// from signIn, before `model`/`day` state have even been set.
const isPastSelectionDeadline = (dateKey, selectionDeadlines) => {
  if (!dateKey) return false;
  const deliveryDate = dateFromKey(dateKey);
  if (Number.isNaN(deliveryDate.getTime())) return false;

  const rule = Array.isArray(selectionDeadlines)
    ? selectionDeadlines.find((d) => d.deliveryDay === DAY_NAMES[deliveryDate.getDay()])
    : null;

  if (!rule) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return deliveryDate < today;
  }

  const deadlineDateLocal = new Date(
    deliveryDate.getFullYear(),
    deliveryDate.getMonth(),
    deliveryDate.getDate() - (rule.daysBefore || 0)
  );
  const [hh, mm] = String(rule.deadlineTime || '23:59').split(':').map(Number);
  deadlineDateLocal.setHours(hh, mm, 59, 999);
  return new Date() > deadlineDateLocal;
};

// Index of the first day whose deadline hasn't passed yet — so a customer
// opening the link after some days have already closed lands straight on a
// day they can still act on, instead of a closed Monday. Falls back to 0
// (and the "Selection closed" banner takes it from there) when every day is
// already closed, or there's nothing to check.
const firstAvailableDayIndex = (dayKeys, selectionDeadlines) => {
  if (!Array.isArray(dayKeys) || dayKeys.length === 0) return 0;
  const idx = dayKeys.findIndex((k) => !isPastSelectionDeadline(k, selectionDeadlines));
  return idx === -1 ? 0 : idx;
};

const tokens = (value) =>
  String(value || '')
    .split(/[,;|\n\r/]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

// portion/carb/vegIngredients are tagged [{name, visible}] lists — every
// ingredient is checked here regardless of its visible flag, since hiding
// an ingredient from the customer must never hide it from an allergy check.
const tagTokens = (list) =>
  (Array.isArray(list) ? list : []).map((t) => String(t?.name || '').trim().toLowerCase()).filter(Boolean);

// Display counterpart to tagTokens — only ingredients marked visible, in
// their original casing, for what's actually shown to the customer.
const visibleIngredientNames = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((t) => t?.visible !== false)
    .map((t) => t?.name)
    .filter(Boolean)
    .join(', ');

// Every ingredient's own display name (unfiltered by visible, like
// tagTokens) — used to report exactly which carb/veg/sauce/garnish
// ingredient triggered an exclusion match, for Kitchen List/kitchen paper.
const tagNames = (list) => (Array.isArray(list) ? list : []).map((t) => t?.name).filter(Boolean);

// Which of `names` (a meal component's own ingredient names) match any of
// the customer's exclusion phrases — mirrors MenuSelection.jsx's
// matchAgainstExclusions, kept here so carb/veg/sauce/garnish swaps can be
// flagged to Kitchen List the same way the legacy selection flow did.
const matchAgainstExclusions = (names, exclusionPhrases) =>
  (Array.isArray(names) ? names : []).filter((name) =>
    (exclusionPhrases || []).some((phrase) => exclusionMatchesTerm(phrase, String(name).trim().toLowerCase()))
  );

const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const initialsOf = (name) =>
  String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/* ---------------------------------------------------------- data models */

// Normalized meal shape used by the renderer regardless of source:
//   { key, dayIndex, dayKey, type, name, sub, allergens[], dietTags[],
//     allergenMatchTokens[], exclMatchTokens[], item? }
// (demo meals carry `allergens` / `dietTags` and are matched directly.)

function buildDemoModel() {
  const dayKeys = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = dateFromKey(DEMO_WEEK_START);
    d.setDate(d.getDate() + i);
    return toDateKey(d);
  });
  const meals = DEMO_MEALS.map((m) => ({
    key: `${dayKeys[m.day]}::${m.type}::${m.id}`,
    dayIndex: m.day,
    dayKey: dayKeys[m.day],
    type: m.type,
    name: m.name,
    sub: m.sub,
    allergens: m.allergens,
    dietTags: m.exclusions,
  }));
  return { menuName: DEMO_MENU_NAME, menuRange: DEMO_MENU_RANGE, dayKeys, meals };
}

function expandSaturdaySkips(dates, deliveryDates) {
  const result = new Set(dates);
  const eligible = new Set(deliveryDates || []);
  dates.forEach((key) => {
    const date = dateFromKey(key);
    if (date.getDay() !== 6) return;
    date.setDate(date.getDate() + 1);
    const sunday = toDateKey(date);
    if (eligible.has(sunday)) result.add(sunday);
  });
  return [...result].sort();
}

function buildRealModel(weeklyMenu, profile) {
  const weekendOk = !!profile?.weekend;
  const rows = Array.isArray(weeklyMenu?.meals) ? weeklyMenu.meals : [];

  // The customer's own Matter delivery calendar decides which days they see
  // (paused / skipped days are not in it). Only when Matter sent no calendar
  // do we fall back to the weekend rule.
  const matterDays = Array.isArray(profile?.deliveryDates) ? new Set(profile.deliveryDates) : null;
  // Keep submitted skips visible even after Matter removes them from active deliveries.
  (profile?.skippedDays || []).forEach((d) => matterDays?.add(toDateKey(d.date || d)));

  const keySet = new Set();
  rows.forEach((row) => {
    const k = toDateKey(row?.date);
    if (!k) return;
    if (matterDays) {
      if (!matterDays.has(k)) return;
    } else if (!weekendOk) {
      const wd = dateFromKey(k).getDay();
      if (wd === 0 || wd === 6) return;
    }
    keySet.add(k);
  });
  const dayKeys = Array.from(keySet).sort();
  const dayIndexByKey = new Map(dayKeys.map((k, i) => [k, i]));

  const meals = [];
  rows.forEach((row) => {
    const dayKey = toDateKey(row?.date);
    if (!dayIndexByKey.has(dayKey)) return;
    // 'lunch'/'dinner' were merged into 'main' — normalize here so menus
    // saved before the migration still render instead of silently dropping.
    const rawType = String(row?.mealType || '').toLowerCase();
    const type = (rawType === 'lunch' || rawType === 'dinner') ? 'main' : rawType;
    if (!COURSES.some((c) => c.key === type)) return;
    (row?.items || []).forEach((item) => {
      if (!item) return;
      const itemId = String(item._id || item);

      // Dietary tokens live on the MenuItem's intolerances / proteinSource /
      // carbs / veg / sauce (comma/semicolon/pipe separated), matched by
      // exact token — same fields and matching the live MenuSelection.jsx
      // uses (its allergenBlockedIds also now checks proteinSource + sauce).
      // proteinSource/carbs/veg/sauce hold the searched recipe's own name;
      // portion/carb/veg/sauceIngredients hold that recipe's actual
      // ingredients — both get scanned so matching stays precise even though
      // only the name is shown to the customer.
      const intoleranceTokens = tokens(item.intolerances);
      const proteinTokens = [...tokens(item.proteinSource), ...tagTokens(item.portionIngredients)];
      const carbTokens = [...tokens(item.carbs), ...tagTokens(item.carbIngredients)];
      const vegTokens = [...tokens(item.veg), ...tagTokens(item.vegIngredients)];
      const sauceTokens = [...tokens(item.sauce), ...tagTokens(item.sauceIngredients)];
      const garnishTokens = tokens(item.garnish);
      const declaredAllergens = Array.isArray(item.allergens)
        ? item.allergens.map((a) => String(a).trim().toLowerCase()).filter(Boolean)
        : tokens(item.allergens);

      // Hard-block set (vs the customer's allergies): every component,
      // sauce/garnish included — a real allergy must always block, no matter
      // which component it's hiding in.
      const allergenMatchTokens = Array.from(
        new Set([...declaredAllergens, ...intoleranceTokens, ...proteinTokens, ...carbTokens, ...vegTokens, ...sauceTokens, ...garnishTokens])
      );
      // Soft-warn set (vs the customer's exclusion phrases) — portion/carb/veg
      // only. A sauce or garnish exclusion match is never shown to the
      // customer here (this component has no per-field modal like
      // MenuSelection.jsx's change-carb/change-veg flow to route it through).
      const exclMatchTokens = Array.from(
        new Set([...proteinTokens, ...carbTokens, ...vegTokens])
      );

      const allergensDisplay = Array.from(
        new Set([...declaredAllergens, ...intoleranceTokens].map((a) => titleCase(a)).filter(Boolean))
      );
      const dietTags = [];
      if (item.isVegan) dietTags.push('Vegan');
      if (item.isGlutenFree) dietTags.push('Gluten-free');
      const subParts = [
        item.ingredients || item.description || '',
        item.calories ? `${item.calories} kcal` : '',
      ].filter(Boolean);
      meals.push({
        key: `${dayKey}::${type}::${itemId}`,
        dayIndex: dayIndexByKey.get(dayKey),
        dayKey,
        type,
        name: item.mealName || 'Meal',
        sub: subParts.join(' · '),
        proteinText: [String(item.proteinSource || '').trim(), visibleIngredientNames(item.portionIngredients)].filter(Boolean).join(' — '),
        carbText: [String(item.carbs || '').trim(), visibleIngredientNames(item.carbIngredients)].filter(Boolean).join(' — '),
        vegText: [String(item.veg || '').trim(), visibleIngredientNames(item.vegIngredients)].filter(Boolean).join(' — '),
        sauceText: [String(item.sauce || '').trim(), visibleIngredientNames(item.sauceIngredients)].filter(Boolean).join(' — '),
        allergens: allergensDisplay,
        allergenMatchTokens,
        exclMatchTokens,
        // Own ingredient display names per component, for reporting exactly
        // which carb/veg/sauce/garnish ingredient conflicts with a
        // customer's exclusion (see matchAgainstExclusions below). Each
        // combines the tagged ingredient list AND the recipe's own plain
        // carbs/veg/sauce field — matching carbTokens/vegTokens/sauceTokens
        // above, since a customer's exclusion can hit either one.
        carbNames: [...tokens(item.carbs).map(titleCase), ...tagNames(item.carbIngredients)],
        vegNames: [...tokens(item.veg).map(titleCase), ...tagNames(item.vegIngredients)],
        sauceNames: [...tokens(item.sauce).map(titleCase), ...tagNames(item.sauceIngredients)],
        garnishNames: tokens(item.garnish).map(titleCase),
        dietTags,
        item,
      });
    });
  });

  const menuName = weeklyMenu?.title || 'This week’s menu';
  const menuRange =
    weeklyMenu?.startDate && weeklyMenu?.endDate
      ? `${fmtShort(weeklyMenu.startDate)} – ${fmtShort(weeklyMenu.endDate)}`
      : '';
  return { menuName, menuRange, dayKeys, meals };
}

/* ---------------------------------------------------------------- component */

const MenuSelectionLink = ({ token }) => {
  const preview = !token;

  const [model, setModel] = useState(() => (preview ? buildDemoModel() : null));
  const [loadState, setLoadState] = useState(preview ? 'ready' : 'loading'); // loading | ready | error
  const [loadError, setLoadError] = useState('');
  const [rawMenu, setRawMenu] = useState(null); // real weeklyMenu (for submit)

  const [step, setStep] = useState('signin'); // signin | menu | done
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [account, setAccount] = useState(null); // normalized customer
  const [day, setDay] = useState(0);
  const [qty, setQty] = useState({});
  const [manualSkipped, setSkipped] = useState({});
  const skipped = useMemo(() => {
    const keys = model?.dayKeys || [];
    const dates = new Set(expandSaturdaySkips(keys.filter((_, i) => manualSkipped[i]), keys));
    return Object.fromEntries(keys.map((key, i) => [i, dates.has(key)]));
  }, [manualSkipped, model]);
  // Snapshot of `skipped` taken at the moment of a successful submit. Once a
  // day has been submitted as skipped, "Change my selections" can no longer
  // un-skip (or re-skip) it — a skip actually pauses that delivery on the
  // backend once submitted, so undoing it here would silently desync from
  // that. Days that had real meal selections stay fully editable.
  const [lockedSkipDays, setLockedSkipDays] = useState({});
  const [acknowledged, setAcknowledged] = useState({});
  // Per-meal-key exclusion flags to carry through to submit: carbVegAction
  // ('kept'/'replace', from the modal below) plus the silent sauce/garnish
  // swap flags Kitchen List reads — see computeSauceGarnishFlags/addWithCap.
  const [mealFlags, setMealFlags] = useState({});
  const [modal, setModal] = useState(null);
  // Pause-confirmation calendar: open only when the customer hits final
  // submit with >=1 day skipped (see onSubmitButton). `skipPauseReview` holds
  // the availability from skip-pause-preview; nothing is sent to select-meals until
  // the customer confirms it (SkipPauseCalendarModal's onConfirm -> doSubmit).
  const [skipPauseReview, setSkipPauseReview] = useState(null); // Availability and pause dates, without generated resume dates.
  const [pausePreviewLoading, setPausePreviewLoading] = useState(false);
  // Frozen at the moment of a successful submit (same convention as
  // lockedSkipDays) so the done screen's Renew button can't drift if the
  // customer later reopens "Change my selections".
  const [renewalEligible, setRenewalEligible] = useState(false);
  const [toast, setToast] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const toastTimer = useRef(null);
  const phoneRef = useRef(null); // the scrollable container (see msl-phone below)
  const activeTabRef = useRef(null); // the current day's tab, inside the horizontally-scrolling strip

  // "Save and go to next day" (and picking a day tab directly) should always
  // land at the top of that day's meals, not wherever the page happened to be
  // scrolled to from the day before. In `preview` mode the phone frame itself
  // scrolls (overflowY: auto on msl-phone); otherwise the real page/window
  // does.
  useEffect(() => {
    if (preview) {
      phoneRef.current?.scrollTo?.({ top: 0 });
    } else if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0 });
    }
  }, [day, preview]);

  // Bring the current day's tab into view within the horizontally-scrolling
  // strip — matters most right after sign-in, when the landing day may not
  // be Monday (see firstAvailableDayIndex) and would otherwise sit
  // off-screen to the right with no visual cue which day is showing.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [day]);

  /* -- load the real menu by share token -- */
  useEffect(() => {
    if (preview) return;
    let alive = true;
    setLoadState('loading');
    api
      .get(`/menus/share/${token}`)
      .then((res) => {
        if (!alive) return;
        const menu = res.data?.data;
        if (!menu) throw new Error('Menu not found');
        setRawMenu(menu);
        setLoadState('ready');
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(
          err.response?.data?.message ||
            'This menu selection link is invalid or has expired. Please contact support.'
        );
        setLoadState('error');
      });
    return () => {
      alive = false;
    };
  }, [preview, token]);

  const flash = useCallback((msg) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /* -- sign in -- */
  const signIn = useCallback(async () => {
    const v = email.trim().toLowerCase();
    if (!v) return setEmailError('Enter your email address to continue.');
    if (v.indexOf('@') < 1 || v.indexOf('.') < 0) return setEmailError("That doesn't look like a valid email.");

    if (preview) {
      const found = DEMO_ACCOUNTS.find((a) => a.email === v);
      if (!found) return setEmailError('No subscription found for this address. Contact support if this is wrong.');
      setAccount({
        name: found.name,
        email: found.email,
        plan: found.plan,
        perDay: found.perDay,
        allergensDisplay: found.allergens,
        allergensLc: found.allergens.map((x) => x.toLowerCase()),
        exclusionsDisplay: found.exclusions,
        exclusionsLc: found.exclusions.map((x) => x.toLowerCase()),
      });
      setModel(buildDemoModel());
      setStep('menu');
      setDay(0);
      setEmailError('');
      return;
    }

    try {
      setEmailError('');
      // Resolves identity/plan data straight from Matter by exact email —
      // not internal Customer Management matching — so a typed email either
      // matches a real subscription or gets a clear "contact customer
      // service" error, never a guessed/fuzzy match to someone else's data.
      const res = await api.get(
        `/menus/customers/${encodeURIComponent(v)}/subscription-profile`,
        { params: { email: v, menuId: rawMenu?._id } }
      );
      const profile = res.data?.data;
      if (!profile) throw new Error('not found');

      const built = buildRealModel(rawMenu, profile);
      const allergensDisplay = (profile.allergies || []).map((x) => titleCase(String(x)));
      // Same parser the live component uses — turns the stored mealExclusion
      // string into canonical exclusion phrases.
      const exclusionPhrases = groupExclusions(profile.mealExclusion);

      setAccount({
        name: `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || profile.email || v,
        email: profile.email || v,
        matterCustomerId: profile.matterCustomerId || profile.customerId || null,
        allergensKnown: profile.allergiesAvailable !== false,
        plan: profile.mealPlan || 'Meal plan',
        perDay: Number(profile.mealPerDay) || 1,
        weekend: !!profile.weekend,
        deliveryDates: profile.deliveryDates || built.dayKeys,
        // Menu-selection Partner members (Customer.unlimitedMeals) have no daily cap.
        unlimitedMeals: !!profile.unlimitedMeals,
        allergensDisplay,
        allergensLc: allergensDisplay.map((x) => x.toLowerCase()),
        exclusionsDisplay: exclusionPhrases,
        exclusionPhrases,
        exclusionsLc: exclusionPhrases.map((x) => x.toLowerCase()),
        // The exact Matter subscription this profile was resolved from —
        // sent back with the submission so it's logged on the selection record.
        subscriptionId: profile.subscriptionId || null,
        // Billing-cycle boundary — see lastCycleDayKey below for how "last
        // day of your cycle" is derived from this against the real delivery
        // calendar, rather than treating this raw date as a delivery day.
        cycleEndDate: profile.cycleEndDate || null,
      });
      setModel(built);

      // preload a previously submitted selection for this menu
      const preQty = {};
      const alreadySubmitted =
        profile.hasSubmittedForRequestedMenu ||
        (profile.currentWeekMenu && rawMenu?._id && String(profile.currentWeekMenu) === String(rawMenu._id));
      if (alreadySubmitted && Array.isArray(profile.selectedMeals)) {
        profile.selectedMeals.forEach((sm) => {
          const itemId = String(sm.menuItemId?._id || sm.menuItemId || '');
          const k = `${toDateKey(sm.date)}::${String(sm.mealType || '').toLowerCase()}::${itemId}`;
          if (itemId) preQty[k] = (preQty[k] || 0) + (Number(sm.quantity) || 1);
        });
      }
      setQty(preQty);
      const savedSkipDates = new Set((profile.skippedDays || []).map((d) => toDateKey(d.date || d)));
      const savedSkips = Object.fromEntries(built.dayKeys.map((key, i) => [i, savedSkipDates.has(key)]));
      setSkipped(savedSkips);
      setLockedSkipDays(savedSkips);
      setAcknowledged({});
      // Land on the first day that isn't already closed, instead of always
      // opening on Monday even when Monday (and maybe more) has passed.
      setDay(firstAvailableDayIndex(built.dayKeys, rawMenu?.selectionDeadlines));
      setStep('menu');
    } catch (err) {
      // Prefer the server's own message (e.g. "We could not find an account
      // under this email. Kindly contact customer service.") over a generic
      // client-side fallback, since meal-profile no longer guesses at a
      // possible match — a 404 here means exactly what it says.
      setEmailError(
        err.response?.data?.message
        || (err.response?.status === 404
          ? 'We could not find an account under this email. Kindly contact customer service.'
          : 'Could not load your plan. Please try again.')
      );
    }
  }, [email, preview, rawMenu]);

  /* -- selection helpers -- */
  const dayKeys = model?.dayKeys || [];
  const lastDay = Math.max(0, dayKeys.length - 1);
  // Menu-selection Partner members (account.unlimitedMeals) have no daily cap —
  // Infinity means addWithCap below never blocks another meal being added.
  const target = account?.unlimitedMeals ? Infinity : (account?.perDay || 3);

  // "Last day of your cycle" is the last REAL delivery day (dayKeys is
  // already filtered to the customer's own Matter calendar + the published
  // menu) on or before the subscription's cycle_end_date — not that raw
  // boundary itself, since it isn't necessarily a delivery day. null when
  // cycleEndDate is unknown, so neither the banner nor the Renew button show.
  const lastCycleDayKey = useMemo(() => {
    if (!account?.cycleEndDate || dayKeys.length === 0) return null;
    // Owner (2026-10-21): the cycle must actually END somewhere within this
    // menu's days for the banner to be relevant. Without this check, a cycle
    // ending weeks from now (well past the whole menu) made every day in
    // dayKeys "eligible" (all <= a far-future cycleEndDate), so `.pop()`
    // silently picked the LAST day of the menu instead — the banner showed
    // every week regardless of whether the cycle was actually ending.
    if (account.cycleEndDate > dayKeys[dayKeys.length - 1]) return null;
    const eligible = dayKeys.filter((k) => k <= account.cycleEndDate);
    return eligible.length ? eligible[eligible.length - 1] : null;
  }, [dayKeys, account]);

  // The day deliveries would resume on with a renewal — the day right after
  // the subscription's own cycle_end_date (the actual billing boundary, not
  // just the last scheduled delivery day, which can land a day or two before
  // it if that boundary itself isn't a delivery day).
  const continuesFromDate = useMemo(() => {
    if (!account?.cycleEndDate) return '';
    const next = dateFromKey(account.cycleEndDate);
    next.setDate(next.getDate() + 1);
    return fmtDayLong(toDateKey(next));
  }, [account]);

  const dayCount = useCallback(
    (i) =>
      (model?.meals || [])
        .filter((m) => m.dayIndex === i)
        .reduce((a, m) => a + (qty[m.key] || 0), 0),
    [model, qty]
  );

  // Whether a delivery day's selection deadline has passed (see
  // isPastSelectionDeadline above) — mirrors the formula in the old
  // MenuSelection.jsx / the Menu Management admin tools. Preview/demo mode
  // never locks — there's no real menu (or real deadlines) behind it.
  const isDayDeadlineLocked = useCallback(
    (dateKey) => (preview ? false : isPastSelectionDeadline(dateKey, rawMenu?.selectionDeadlines)),
    [preview, rawMenu]
  );

  const deadlineLockedToday = isDayDeadlineLocked(dayKeys[day]);

  const conflictOf = useCallback(
    (m) => {
      if (!account) return null;

      // Hard block using complete ingredient phrases, including hidden tags.
      const allergenTokens = preview ? m.allergens || [] : m.allergenMatchTokens || [];
      const al = account.allergensLc.filter((allergy) => allergenMatchesAny(allergy, allergenTokens));
      if (al.length) return { kind: 'allergen', items: Array.from(new Set(al.map(titleCase))) };

      // soft warn — customer's exclusions found among the meal's dietary tokens.
      // exclusionMatchesAny covers umbrella phrases like "All Nuts"/"All Fish"
      // (see constants/exclusionList.js) as well as an exact match.
      let ex;
      if (preview) {
        ex = (m.dietTags || []).filter((t) => account.exclusionsLc.includes(String(t).toLowerCase()));
      } else {
        ex = (account.exclusionPhrases || []).filter((p) => exclusionMatchesAny(p, m.exclMatchTokens || []));
      }
      if (ex.length) {
        // Which of the meal's own carb/veg ingredients actually caused the
        // match — lets the modal offer a "keep it / have the kitchen
        // replace it" choice instead of the generic "pick something else"
        // one, and lets that choice be recorded (carbVegAction) for Kitchen
        // List, same as the legacy MenuSelection.jsx change-carb/veg flow.
        const exclusionPhrases = preview ? [] : (account.exclusionPhrases || []);
        const matchedCarb = matchAgainstExclusions(m.carbNames || [], exclusionPhrases);
        const matchedVeg = matchAgainstExclusions(m.vegNames || [], exclusionPhrases);
        return { kind: 'exclusion', items: Array.from(new Set(ex)), matchedCarb, matchedVeg };
      }
      return null;
    },
    [account, preview]
  );

  const bump = useCallback((key, delta) => {
    setQty((s) => ({ ...s, [key]: Math.max(0, (s[key] || 0) + delta) }));
  }, []);

  // Sauce/garnish exclusion matches are never shown to the customer or
  // blocked — the meal is added normally either way, this just carries the
  // flag through to Kitchen List so staff know to swap that component
  // before it goes out (mirrors MenuSelection.jsx's sauceGarnishFlags).
  const computeSauceGarnishFlags = useCallback(
    (m) => {
      const exclusionPhrases = preview ? [] : (account?.exclusionPhrases || []);
      const matchedSauce = matchAgainstExclusions(m.sauceNames || [], exclusionPhrases);
      const matchedGarnish = matchAgainstExclusions(m.garnishNames || [], exclusionPhrases);
      return {
        needsSauceChange: matchedSauce.length > 0,
        needsGarnishChange: matchedGarnish.length > 0,
        sauceConflict: matchedSauce,
        garnishConflict: matchedGarnish,
      };
    },
    [account, preview]
  );

  // Adds one meal but never lets a day exceed the customer's meals-per-day.
  // `extraFlags` (carbVegAction + its conflict lists, from the exclusion
  // modal) are merged with the always-computed silent sauce/garnish flags
  // and stashed per meal key so doSubmit can attach them to the selection.
  const addWithCap = useCallback(
    (m, extraFlags = {}) => {
      const dayTotal = (model?.meals || [])
        .filter((mm) => mm.dayIndex === m.dayIndex)
        .reduce((a, mm) => a + (qty[mm.key] || 0), 0);
      if (dayTotal >= target) {
        flash(`You can pick up to ${target} meal${target === 1 ? '' : 's'} for this day.`);
        return false;
      }
      bump(m.key, 1);
      setMealFlags((s) => ({ ...s, [m.key]: { ...computeSauceGarnishFlags(m), ...extraFlags } }));
      return true;
    },
    [bump, computeSauceGarnishFlags, flash, model, qty, target]
  );

  const openAllergen = useCallback(
    (items) => {
      setModal({
        kicker: 'Blocked meal',
        title: `Contains ${items.join(' and ')}`,
        body:
          "This meal can't be selected because it contains an allergen on your profile. If you believe your allergen list is out of date, message the kitchen team and they'll update it for you.",
        items: items.map((x) => ({ label: x, bg: '#FEE2E2', fg: '#991B1B' })),
        actions: [
          { label: 'Close', kind: 'secondary', onClick: () => setModal(null) },
          {
            label: 'Message customer service',
            kind: 'danger',
            onClick: () => {
              setModal(null);
              flash('Request sent to customer service');
            },
          },
        ],
      });
    },
    [flash]
  );

  const openExclusion = useCallback(
    (m, conflict) => {
      const items = conflict.items || [];
      const carbVegNames = [...(conflict.matchedCarb || []), ...(conflict.matchedVeg || [])];
      const hasCarbVeg = carbVegNames.length > 0;

      const carbVegFlags = (action) => ({
        carbVegAction: action,
        carbVegConflict: carbVegNames,
        carbConflict: conflict.matchedCarb || [],
        vegConflict: conflict.matchedVeg || [],
      });

      setModal({
        kicker: 'Against your preferences',
        title: `This meal includes ${items.join(', ')}`,
        body: hasCarbVeg
          ? `${m.name} conflicts with an exclusion on your plan. Would you like the kitchen to replace the ${carbVegNames.join(', ')}, or keep it as is?`
          : `${m.name} conflicts with an exclusion on your plan. You can keep it in your selection anyway, or pick something else for this slot.`,
        items: items.map((x) => ({ label: x, bg: 'var(--color-neutral-200)', fg: 'var(--color-neutral-800)' })),
        actions: hasCarbVeg
          ? [
              {
                label: 'Replace it',
                kind: 'secondary',
                onClick: () => {
                  setModal(null);
                  setAcknowledged((s) => ({ ...s, [m.key]: true }));
                  if (addWithCap(m, carbVegFlags('replace'))) flash('Added — kitchen will replace it');
                },
              },
              {
                label: 'Keep as is',
                kind: 'primary',
                onClick: () => {
                  setModal(null);
                  setAcknowledged((s) => ({ ...s, [m.key]: true }));
                  if (addWithCap(m, carbVegFlags('kept'))) flash('Added — kept as is');
                },
              },
            ]
          : [
              { label: 'Replace with another', kind: 'secondary', onClick: () => setModal(null) },
              {
                label: 'Keep selection',
                kind: 'primary',
                onClick: () => {
                  setModal(null);
                  setAcknowledged((s) => ({ ...s, [m.key]: true }));
                  if (addWithCap(m)) flash('Added — exclusion acknowledged');
                },
              },
            ],
      });
    },
    [addWithCap, flash]
  );

  const tryAdd = useCallback(
    (m) => {
      const c = conflictOf(m);
      if (c && c.kind === 'allergen') return openAllergen(c.items);
      if (c && c.kind === 'exclusion' && !acknowledged[m.key]) return openExclusion(m, c);
      addWithCap(m);
    },
    [acknowledged, addWithCap, conflictOf, openAllergen, openExclusion]
  );

  /* -- submit -- */
  // `pauseDecisions` is only non-null when the pause-confirmation calendar
  // was shown and confirmed (see openSkipPauseReview/handleConfirmPauseReview
  // below) — one {date, action:'pause'|'decline', resumeDate, alreadyPaused}
  // per skipped day, exactly what the customer saw and approved. Nothing
  // about pausing is ever recomputed server-side from this; the server
  // applies these decisions verbatim (routes/menus.js select-meals).
  const doSubmit = useCallback(async (pauseDecisions) => {
    // Recheck restored selections too: a customer's allergy profile may have
    // changed since their previous submission, without going through tryAdd.
    const blockedMeal = (model?.meals || []).find((m) => qty[m.key] > 0 && !skipped[m.dayIndex] && conflictOf(m)?.kind === 'allergen');
    if (blockedMeal) {
      flash(`Remove ${blockedMeal.name} before submitting: it conflicts with your allergy profile.`);
      return;
    }
    if (preview) {
      setLockedSkipDays(skipped);
      setStep('done');
      return;
    }
    setSubmitting(true);
    try {
      const selections = [];
      (model?.meals || []).forEach((m) => {
        const n = qty[m.key] || 0;
        if (!n || skipped[m.dayIndex]) return;
        selections.push({
          date: m.dayKey,
          mealType: m.type,
          menuItemId: m.item?._id || undefined,
          mealName: m.name,
          quantity: n,
          // carbVegAction/carbConflict/vegConflict (from the exclusion modal)
          // and needsSauceChange/needsGarnishChange (silent) — see addWithCap.
          ...(mealFlags[m.key] || {}),
        });
      });
      const skippedDates = [...new Set([
        ...expandSaturdaySkips(dayKeys.filter((_, i) => skipped[i]), account.deliveryDates || dayKeys),
        ...(pauseDecisions || []).map((d) => d.date),
      ])];
      const res = await api.post(`/menus/customers/${encodeURIComponent(account.email)}/select-meals`, {
        weeklyMenuId: rawMenu._id,
        selections,
        skippedDates,
        matterCustomerId: account.matterCustomerId || undefined,
        subscriptionId: account.subscriptionId || undefined,
        ...(pauseDecisions ? { pauseDecisions } : {}),
      });
      if (res.data?.success) {
        const failedPauses = (res.data.pauseResults || []).filter((p) => p.pauseStatus === 'failed');
        if (failedPauses.length) {
          setSkipPauseReview((review) => review ? {
            ...review,
            submissionError: `Your meals were saved, but ${failedPauses.length} pause(s) could not be applied. Please review the dates and retry, or contact customer service.`,
            pauses: review.pauses.map((p) => {
              const result = res.data.pauseResults.find((r) => r.date === p.date);
              const confirmed = pauseDecisions?.find((d) => d.date === p.date);
              return { ...p, alreadyPaused: p.alreadyPaused || ['success', 'already_paused'].includes(result?.pauseStatus), resumeDate: result?.resumeDate || confirmed?.resumeDate || p.resumeDate };
            }),
          } : review);
          return;
        }
        setSkipPauseReview(null);
        setLockedSkipDays(skipped);
        setRenewalEligible(!!lastCycleDayKey);
        setStep('done');
      } else {
        flash(res.data?.message || 'Could not save your selections.');
      }
    } catch (err) {
      flash(err.response?.data?.message || 'Could not save your selections. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [account, conflictOf, dayKeys, flash, lastCycleDayKey, mealFlags, model, preview, qty, rawMenu, skipped]);

  // Fetches available dates for the currently-skipped days and opens
  // the pause-confirmation calendar. Never calls select-meals itself — the
  // whole submission (meals + pauses) waits for the modal's confirm action
  // (handleConfirmPauseReview below).
  const openSkipPauseReview = useCallback(async (skippedDateKeys) => {
    setPausePreviewLoading(true);
    setSkipPauseReview({ pauses: skippedDateKeys.map((date) => ({ date, alreadyPaused: false, resumeDate: null })) });
    try {
      const res = await api.post(`/menus/customers/${encodeURIComponent(account.email)}/skip-pause-preview`, {
        dates: skippedDateKeys,
      });
      const pauses = res.data?.data?.pauses;
      setSkipPauseReview({ ...res.data?.data, pauses: Array.isArray(pauses) && pauses.length ? pauses : skippedDateKeys.map((date) => ({ date, alreadyPaused: false, resumeDate: null })) });
    } catch (err) {
      // Never block the customer from reviewing/confirming their skips just
      // because the suggestion lookup failed — they can still pick resume
      // dates by hand in the calendar.
      setSkipPauseReview({ pauses: [], availabilityError: 'Could not verify your active deliveries. Go back and submit again to retry.' });
    } finally {
      setPausePreviewLoading(false);
    }
  }, [account, flash]);

  const handleConfirmPauseReview = useCallback((decisions) => {
    doSubmit(decisions);
  }, [doSubmit]);

  const handleCancelPauseReview = useCallback(() => {
    setSkipPauseReview(null);
  }, []);

  const onSubmitButton = useCallback(() => {
    // A day is either skipped entirely, or filled to exactly the customer's
    // meals-per-day count — no partial days (e.g. 1 of 3) get through to the
    // next day or the final submit. That requirement is waived once the
    // day's own deadline has already passed — there's nothing left for the
    // customer to fix, so it shouldn't block them from moving on.
    const isSkipped = !!skipped[day];
    const chosen = dayCount(day);
    // Unlimited customers have no required minimum either — any count (including 0) submits.
    if (!isSkipped && !deadlineLockedToday && !account?.unlimitedMeals && chosen < target) {
      flash(
        chosen === 0
          ? `Please select ${target} meal${target === 1 ? '' : 's'} for this day, or skip it.`
          : `You've picked ${chosen} of ${target} meal${target === 1 ? '' : 's'} — select all ${target}, or skip this day instead.`
      );
      return;
    }
    if (day < lastDay) {
      setDay((d) => d + 1);
      return;
    }
    const skippedDateKeys = expandSaturdaySkips(dayKeys.filter((_, i) => skipped[i]), account?.deliveryDates || dayKeys);
    if (preview || skippedDateKeys.length === 0) {
      doSubmit();
      return;
    }
    openSkipPauseReview(skippedDateKeys);
  }, [account, day, dayCount, dayKeys, deadlineLockedToday, doSubmit, flash, lastDay, openSkipPauseReview, preview, skipped, target]);

  const resetAll = useCallback(() => {
    setStep('signin');
    setAccount(null);
    setEmail('');
    setEmailError('');
    setQty({});
    setSkipped({});
    setLockedSkipDays({});
    setAcknowledged({});
    setMealFlags({});
    setModal(null);
    setSkipPauseReview(null);
    setPausePreviewLoading(false);
    setRenewalEligible(false);
    setDay(0);
  }, []);

  /* ------------------------------------------------------- derived render */

  const skippedToday = !!skipped[day];
  // Locked once this day was submitted as skipped (see doSubmit) — "Change
  // my selections" can revisit it, but the skip itself can't be undone.
  const skipLockedToday = !!lockedSkipDays[day];
  const currentDate = dayKeys[day] ? dateFromKey(dayKeys[day]) : null;
  const previousDate = currentDate ? new Date(currentDate) : null;
  previousDate?.setDate(previousDate.getDate() - 1);
  const sundayIncluded = currentDate?.getDay() === 0 && !!skipped[dayKeys.indexOf(toDateKey(previousDate))];
  const dayHeading = dayKeys[day] ? fmtDayLong(dayKeys[day]) : `Day ${day + 1}`;
  const selectedToday = dayCount(day);
  const dayFull = !skippedToday && selectedToday >= target;

  const courses = useMemo(() => {
    if (!model || !account) return [];
    return COURSES.map((c) => {
      const list = (model.meals || []).filter((m) => m.dayIndex === day && m.type === c.key);
      return {
        label: c.label,
        count: `${list.length} option${list.length === 1 ? '' : 's'}`,
        meals: list.map((m) => {
          const conflict = conflictOf(m);
          const blocked = !!(conflict && conflict.kind === 'allergen');
          const warned = !!(conflict && conflict.kind === 'exclusion');
          const q = qty[m.key] || 0;
          const bag = BAG[m.type] || BAG.dinner;
          const tags = (m.allergens || [])
            .map((x) => ({
              label: x,
              bg: account.allergensLc.some((allergy) => allergenMatchesAny(allergy, [x]))
                ? '#FEE2E2'
                : 'var(--color-neutral-200)',
              fg: account.allergensLc.some((allergy) => allergenMatchesAny(allergy, [x]))
                ? '#991B1B'
                : 'var(--color-neutral-700)',
            }))
            .concat(
              (m.dietTags || []).map((x) => ({
                label: x,
                bg: 'var(--color-accent-2-200)',
                fg: 'var(--color-accent-2-900)',
              }))
            );
          return {
            m,
            name: m.name,
            sub: m.sub,
            proteinText: m.proteinText,
            carbText: m.carbText,
            vegText: m.vegText,
            // sauceText / garnish are intentionally never shown to the
            // customer — see needsSauceChange/needsGarnishChange, which flag
            // a swap to the kitchen instead (Kitchen List: "Change sauce" /
            // "Change garnish"). Keep sauceNames/garnishNames (used by
            // computeSauceGarnishFlags above) out of what reaches the card.
            typeLabel: c.label,
            bagBg: blocked ? '#FEE2E2' : bag.bg,
            bagFg: blocked ? '#991B1B' : bag.fg,
            cardBorder: blocked ? '#DC2626' : q ? 'var(--color-accent)' : 'var(--color-neutral-300)',
            // Blocked cards stay at full opacity — the red styling itself is
            // the "don't pick this" signal, so nothing about it (including
            // the Ask customer service button) should be faded/harder to see.
            cardOpacity: 1,
            statusLabel: blocked
              ? 'Blocked · allergen'
              : warned
              ? 'Against your plan'
              : q
              ? `${q} selected`
              : '',
            statusBg: blocked
              ? '#DC2626'
              : warned
              ? 'var(--color-neutral-200)'
              : 'var(--color-accent-700)',
            statusFg: blocked
              ? '#ffffff'
              : warned
              ? 'var(--color-neutral-800)'
              : '#ffffff',
            tags,
            blocked,
            warned,
            selectable: !blocked && !deadlineLockedToday,
            qty: q,
            minusDisabled: q === 0 || deadlineLockedToday,
            plusDisabled: dayFull || deadlineLockedToday,
            onCard: () => {
              if (deadlineLockedToday) return;
              if (blocked) return openAllergen(conflict.items);
              if (warned && !acknowledged[m.key]) return openExclusion(m, conflict);
            },
            onPlus: () => tryAdd(m),
            onMinus: () => bump(m.key, -1),
          };
        }),
      };
    }).filter((c) => c.meals.length > 0);
  }, [account, acknowledged, bump, conflictOf, day, dayFull, deadlineLockedToday, model, openAllergen, openExclusion, qty, tryAdd]);

  const dayTabs = useMemo(
    () =>
      dayKeys.map((k, i) => {
        const d = dateFromKey(k);
        const on = i === day;
        const isSkip = !!skipped[i];
        const n = dayCount(i);
        const isComplete = !isSkip && (account?.unlimitedMeals ? n > 0 : target > 0 && n >= target);
        const isPastDeadline = isDayDeadlineLocked(k);

        // Status color always shows — skipped days are amber, fully-picked
        // days (exactly their meal count) are green, and a day whose
        // deadline passed with nothing decided is greyed out — regardless of
        // whether it's the day currently being viewed. The currently-viewed
        // day gets a ring on top of that (see `current` below) instead of
        // losing its status color to a solid highlight fill.
        let bg = 'transparent';
        let fg = 'var(--color-text)';
        let border = 'var(--color-neutral-300)';
        if (isSkip) {
          bg = '#FEF3C7';
          fg = '#92400E';
          border = '#F2C14E';
        } else if (isComplete) {
          bg = 'var(--color-accent-2-200)';
          fg = 'var(--color-accent-2-900)';
          border = 'var(--color-accent-2-700)';
        } else if (isPastDeadline) {
          bg = 'var(--color-neutral-200)';
          fg = 'var(--color-neutral-600)';
          border = 'var(--color-neutral-400)';
        }

        return {
          key: k,
          dow: DAYS[d.getDay()] || '',
          num: d.getDate() || i + 1,
          badge: isSkip ? 'skip' : isComplete ? `${n} sel` : isPastDeadline ? 'closed' : n ? `${n} sel` : '–',
          bg,
          fg,
          border,
          current: on,
          onClick: () => setDay(i),
        };
      }),
    [account, day, dayCount, dayKeys, isDayDeadlineLocked, skipped, target]
  );

  const summary = useMemo(
    () =>
      dayKeys.map((k, i) => {
        const picks = (model?.meals || [])
          .filter((m) => m.dayIndex === i && (qty[m.key] || 0) > 0)
          .map((m) => m.name);
        return {
          day: fmtDayLong(k),
          value: skipped[i] ? 'Skipped' : picks.length ? picks.join(', ') : 'No meals',
        };
      }),
    [dayKeys, model, qty, skipped]
  );

  const customer = account
    ? {
        name: account.name,
        firstName: (account.name || '').split(' ')[0],
        email: account.email,
        initials: initialsOf(account.name),
        plan: account.plan,
        perDay: account.unlimitedMeals ? 'Unlimited' : `${account.perDay} meal${account.perDay === 1 ? '' : 's'}`,
        // Split so allergens (hard-block, from the customer's profile) and
        // dietary exclusions (soft-warn, from mealExclusion) each get their
        // own labeled section instead of one merged, ambiguous tag list.
        allergenFlags: account.allergensDisplay.map((x) => ({
          label: x,
          bg: 'var(--color-accent-200)',
          fg: 'var(--color-accent-900)',
        })),
        exclusionFlags: account.exclusionsDisplay.map((x) => ({
          label: x,
          bg: 'var(--color-accent-2-200)',
          fg: 'var(--color-accent-2-900)',
        })),
      }
    : null;

  // Before sign-in `model` is still null on a real link (it's only built from
  // the customer's profile after they submit their email) — but the menu
  // itself (`rawMenu`) is already loaded via the share token, so the sign-in
  // screen can and should show its real title instead of the demo
  // placeholder. The demo value is the true fallback only in `preview` mode,
  // where there's no real menu at all.
  const menuName = model?.menuName || rawMenu?.title || (preview ? DEMO_MENU_NAME : 'This week’s menu');

  /* --------------------------------------------------------------- markup */

  const OUTER = {
    minHeight: '100vh',
    background: '#ffffff',
    fontFamily: 'var(--font-body)',
    color: 'var(--color-text)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: preview ? '36px 20px 60px' : '0',
  };
  const FRAME = preview
    ? {
        width: 390,
        height: 844,
        background: '#ffffff',
        borderRadius: 34,
        border: '1px solid var(--color-neutral-300)',
        boxShadow: 'var(--shadow-lg)',
        position: 'relative',
        overflow: 'hidden',
      }
    : {
        width: '100%',
        maxWidth: 430,
        minHeight: '100vh',
        background: '#ffffff',
        position: 'relative',
        overflow: 'hidden',
      };

  const renderSignIn = () => (
    <div style={{ minHeight: preview ? 844 : '100vh', display: 'flex', flexDirection: 'column', padding: '54px 26px 32px' }}>
      <MatterLogo height={28} style={{ alignSelf: 'flex-start', marginBottom: 40 }} />
      <h2 style={{ margin: '0 0 30px' }}>{toSentenceCase(menuName)}</h2>
      <p style={{ margin: '0 0 24px', fontSize: 15, lineHeight: 1.6 }}>
        Enter the email your subscription is registered to. We&apos;ll load your plan and this week&apos;s meals.
      </p>

      <div className="field">
        <label htmlFor="msl-email">Email address</label>
        <input
          id="msl-email"
          className="input"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') signIn(); }}
          placeholder="you@example.com"
          style={{ fontSize: 16 }}
        />
      </div>
      {emailError ? (
        <div style={{ fontSize: 13, color: 'var(--color-accent-700)', marginTop: 8 }}>{emailError}</div>
      ) : null}

      <button className="btn btn-primary btn-block" onClick={signIn} style={{ marginTop: 20, padding: 15 }}>
        Continue
      </button>

      {preview ? (
        <div style={{ marginTop: 'auto', paddingTop: 28 }}>
          <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-neutral-600)', marginBottom: 10 }}>
            Demo accounts
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                className="btn btn-secondary"
                onClick={() => { setEmail(a.email); setEmailError(''); }}
                style={{ fontSize: 13, justifyContent: 'flex-start', textAlign: 'left' }}
              >
                {a.name} · {a.plan}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  const renderMenu = () => (
    <div style={{ padding: '0 0 20px' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: '#fff', padding: '18px 22px 14px', borderBottom: '1px solid var(--color-divider)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <MatterLogo height={19} />
          <button className="btn btn-ghost" onClick={resetAll} style={{ fontSize: 12, padding: '4px 8px' }}>Sign out</button>
        </div>
      </div>

      {/* profile card */}
      <div style={{ padding: '20px 22px 0' }}>
        <div className="card elev-sm" style={{ padding: 20, gap: 0, background: 'var(--color-accent-100)', borderColor: 'var(--color-accent-300)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <div style={{ width: 48, height: 48, flex: 'none', borderRadius: 999, background: 'var(--color-accent-700)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 600 }}>
              {customer.initials}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 19, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{customer.name}</div>
              <div className="text-muted" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{customer.email}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ background: '#fff', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
              <div style={{ fontSize: 10, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--color-neutral-600)' }}>Plan</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{customer.plan}</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
              <div style={{ fontSize: 10, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--color-neutral-600)' }}>Meals per day</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{customer.perDay}</div>
            </div>
            <div style={{ gridColumn: 'span 2', background: '#fff', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
              <div style={{ fontSize: 10, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--color-neutral-600)', marginBottom: 6 }}>Allergens</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {customer.allergenFlags.length === 0 ? (
                  <span className="text-muted" style={{ fontSize: 12 }}>{account?.allergensKnown === false ? 'No internal allergy profile found' : 'None on file'}</span>
                ) : (
                  customer.allergenFlags.map((f, i) => (
                    <span key={i} className="tag" style={{ fontSize: 11, padding: '3px 9px', background: f.bg, color: f.fg }}>{f.label}</span>
                  ))
                )}
              </div>
            </div>
            <div style={{ gridColumn: 'span 2', background: '#fff', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
              <div style={{ fontSize: 10, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--color-neutral-600)', marginBottom: 6 }}>Exclusions</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {customer.exclusionFlags.length === 0 ? (
                  <span className="text-muted" style={{ fontSize: 12 }}>None on file</span>
                ) : (
                  customer.exclusionFlags.map((f, i) => (
                    <span key={i} className="tag" style={{ fontSize: 11, padding: '3px 9px', background: f.bg, color: f.fg }}>{f.label}</span>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* day tabs */}
      <div style={{ padding: '18px 22px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
          <h5 style={{ margin: 0 }}>{dayHeading}</h5>
          <span className="text-muted" style={{ fontSize: 12 }}>
            {skippedToday
              ? 'Skipped'
              : account?.unlimitedMeals
                ? `${selectedToday} chosen`
                : dayFull ? `${target} of ${target} chosen · full` : `${selectedToday} of ${target} chosen`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8 }}>
          {dayTabs.map((d) => (
            <button
              key={d.key}
              ref={d.current ? activeTabRef : undefined}
              className="btn"
              onClick={d.onClick}
              style={{
                flex: 'none',
                minWidth: 52,
                padding: '9px 6px',
                fontSize: 12,
                lineHeight: 1.2,
                flexDirection: 'column',
                gap: 2,
                background: d.bg,
                color: d.fg,
                borderColor: d.border,
                boxShadow: d.current ? 'inset 0 0 0 2px var(--color-accent-700)' : 'none',
              }}
            >
              <span style={{ fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase', opacity: 0.85 }}>{d.dow}</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{d.num}</span>
              <span style={{ fontSize: 9.5, opacity: 0.85 }}>{d.badge}</span>
            </button>
          ))}
        </div>
      </div>

      {/* skip toggle */}
      <div style={{ padding: '6px 22px 0' }}>
        <div className="card" style={{ padding: '14px 16px', gap: 0, background: 'var(--color-neutral-100)', borderColor: 'var(--color-neutral-300)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {skippedToday ? 'You skipped this day' : 'Not eating on this day?'}
              </div>
              <div className="text-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                {sundayIncluded && !skipLockedToday
                  ? 'Included because Saturday is skipped.'
                  : skipLockedToday
                  ? 'Already submitted — contact customer service to change this.'
                  : deadlineLockedToday
                    ? 'The deadline for this day has passed — contact customer service to change this.'
                    : skippedToday
                      ? 'No delivery scheduled.'
                      : currentDate?.getDay() === 6 ? 'Skipping Saturday also skips Sunday.' : 'Skip before browsing the menu.'}
              </div>
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => setSkipped((s) => ({ ...s, [day]: !s[day] }))}
              disabled={skipLockedToday || deadlineLockedToday || sundayIncluded}
              title={
                skipLockedToday
                  ? 'This skip was already submitted and can no longer be changed here.'
                  : deadlineLockedToday
                    ? 'The deadline for this day has passed.'
                    : undefined
              }
              style={{ fontSize: 13, whiteSpace: 'nowrap' }}
            >
              {skippedToday ? 'Undo skip' : 'Skip this day'}
            </button>
          </div>
        </div>
      </div>

      {!skippedToday && deadlineLockedToday && (
        <div style={{ padding: '18px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>🔒</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#991B1B' }}>Selection closed</div>
              <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#991B1B', lineHeight: 1.5 }}>
                The deadline to select meals for {dayHeading} has passed. What's shown below is read-only.
              </p>
            </div>
          </div>
        </div>
      )}

      {!skippedToday && dayKeys[day] === lastCycleDayKey && (
        <div style={{ padding: '18px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, background: 'var(--color-accent-200)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Last day of your cycle</div>
              <p className="text-muted" style={{ margin: '2px 0 0', fontSize: 12.5, lineHeight: 1.5 }}>
                Renew so deliveries continue from {continuesFromDate}.
              </p>
            </div>
            <a
              href="https://www.matternutrition.xyz/"
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary"
              style={{ fontSize: 13, flex: 'none', padding: '10px 18px' }}
            >
              Renew
            </a>
          </div>
        </div>
      )}

      {skippedToday ? (
        <div style={{ padding: '26px 22px' }}>
          <div style={{ border: '1px dashed var(--color-neutral-400)', borderRadius: 'var(--radius-lg)', padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 19, marginBottom: 6 }}>Day skipped</div>
            <p className="text-muted" style={{ margin: 0, fontSize: 14 }}>No meals will be delivered on {dayHeading}.</p>
          </div>
        </div>
      ) : (
        <div style={{ padding: '20px 22px 0', display: 'flex', flexDirection: 'column', gap: 24 }}>
          {courses.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 14 }}>No meals published for this day yet.</p>
          ) : (
            courses.map((course) => (
              <div key={course.label}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                  <h6 style={{ margin: 0, color: 'var(--color-text)' }}>{course.label}</h6>
                  <span className="text-muted" style={{ fontSize: 12 }}>{course.count}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {course.meals.map((mc) => (
                    <div key={mc.m.key} className="card" style={{ padding: 0, gap: 0, overflow: 'hidden', borderColor: mc.cardBorder, opacity: mc.cardOpacity }}>
                      <div onClick={mc.onCard} style={{ height: 44, background: mc.bagBg, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0 12px', cursor: 'pointer' }}>
                        <span className="tag" style={{ fontSize: 10.5, padding: '3px 9px', background: '#fff', color: mc.bagFg, fontWeight: 600 }}>{mc.typeLabel}</span>
                        {mc.statusLabel ? (
                          <span className="tag" style={{ fontSize: 10.5, padding: '3px 9px', background: mc.statusBg, color: mc.statusFg, fontWeight: 600 }}>{mc.statusLabel}</span>
                        ) : null}
                      </div>
                      <div style={{ padding: '14px 16px 16px' }}>
                        <div onClick={mc.onCard} style={{ cursor: 'pointer' }}>
                          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.01em', marginBottom: 8 }}>{mc.name}</div>
                          {mc.sub ? <div className="text-muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 10 }}>{mc.sub}</div> : null}
                          {mc.tags.length ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 14 }}>
                              {mc.tags.map((t, i) => (
                                <span key={i} className="tag" style={{ fontSize: 11, padding: '3px 9px', background: t.bg, color: t.fg }}>{t.label}</span>
                              ))}
                            </div>
                          ) : null}
                          {(mc.proteinText || mc.carbText || mc.vegText) ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 14 }}>
                              {mc.proteinText ? (
                                <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                                  <span style={{ color: 'var(--color-neutral-600)', fontWeight: 600 }}>Portion: </span>
                                  <span className="text-muted">{mc.proteinText}</span>
                                </div>
                              ) : null}
                              {mc.carbText ? (
                                <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                                  <span style={{ color: 'var(--color-neutral-600)', fontWeight: 600 }}>Carb: </span>
                                  <span className="text-muted">{mc.carbText}</span>
                                </div>
                              ) : null}
                              {mc.vegText ? (
                                <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                                  <span style={{ color: 'var(--color-neutral-600)', fontWeight: 600 }}>Veg: </span>
                                  <span className="text-muted">{mc.vegText}</span>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        {mc.blocked ? (
                          <button
                            className="btn btn-block"
                            onClick={mc.onCard}
                            style={{ fontSize: 14, fontWeight: 600, background: '#ffffff', color: '#051747', borderColor: '#DC2626' }}
                          >
                            Ask customer service
                          </button>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <button className="btn btn-secondary" onClick={mc.onMinus} disabled={mc.minusDisabled} style={{ width: 44, height: 44, padding: 0, fontSize: 19, lineHeight: 1 }}>
                              &#8722;
                            </button>
                            <div style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--font-heading)', fontSize: 19, fontVariantNumeric: 'tabular-nums' }}>{mc.qty}</div>
                            <button className="btn btn-primary" onClick={mc.onPlus} disabled={mc.plusDisabled} style={{ width: 44, height: 44, padding: 0, fontSize: 19, lineHeight: 1 }}>+</button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* sticky footer */}
      <div style={{ position: 'sticky', bottom: 0, marginTop: 26, background: '#fff', borderTop: '1px solid var(--color-divider)', padding: '14px 22px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
          <span className="text-muted" style={{ fontSize: 12.5 }}>
            {skippedToday ? 'This day is skipped' : `Selected for ${dayKeys[day] ? DAYS[dateFromKey(dayKeys[day]).getDay()] : ''}`}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {skippedToday ? '–' : account?.unlimitedMeals ? selectedToday : `${selectedToday}/${target}`}
          </span>
        </div>
        <button className="btn btn-primary btn-block" onClick={onSubmitButton} disabled={submitting} style={{ padding: 14 }}>
          {submitting ? 'Saving…' : day < lastDay ? 'Save and go to next day' : 'Submit my week'}
        </button>
      </div>
    </div>
  );

  const renderDone = () => (
    <div style={{ minHeight: preview ? 844 : '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '40px 28px' }}>
      <div style={{ width: 64, height: 64, borderRadius: 999, background: 'var(--color-accent-2-300)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: 'var(--color-accent-2-900)', marginBottom: 22 }}>
        &#10003;
      </div>
      <h2 style={{ margin: '0 0 10px' }}>Selections received</h2>
      <p className="text-muted" style={{ margin: '0 0 24px', fontSize: 15, lineHeight: 1.6 }}>
        Thanks {customer?.firstName} — your week is locked in.
      </p>
      <div className="card" style={{ padding: 18, gap: 0 }}>
        {summary.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--color-divider)' }}>
            <span style={{ fontSize: 13.5, whiteSpace: 'nowrap' }}>{s.day}</span>
            <span className="text-muted" style={{ fontSize: 13, textAlign: 'right' }}>{s.value}</span>
          </div>
        ))}
      </div>
      {renewalEligible && (
        <a
          href="https://www.matternutrition.xyz/"
          target="_blank"
          rel="noreferrer"
          className="btn btn-primary btn-block"
          style={{ marginTop: 20, textAlign: 'center' }}
        >
          Renew my subscription
        </a>
      )}
      <button className="btn btn-secondary btn-block" onClick={() => setStep('menu')} style={{ marginTop: 10 }}>
        Change my selections
      </button>
    </div>
  );

  const renderModal = () =>
    modal ? (
      <div
        className="dialog-backdrop"
        style={{ position: preview ? 'absolute' : 'fixed', inset: 0, borderRadius: preview ? 34 : 0, zIndex: 60, padding: 22 }}
        onClick={() => setModal(null)}
      >
        <div className="dialog elev-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '100%' }}>
          <h6 className="text-muted" style={{ margin: 0 }}>{modal.kicker}</h6>
          <div className="dialog-title" style={{ fontSize: 21 }}>{modal.title}</div>
          <div className="dialog-body" style={{ opacity: 1 }}>
            <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.6 }}>{modal.body}</p>
            {modal.items && modal.items.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {modal.items.map((it, i) => (
                  <span key={i} className="tag" style={{ fontSize: 11.5, padding: '4px 10px', background: it.bg, color: it.fg }}>{it.label}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="dialog-actions" style={{ flexWrap: 'wrap' }}>
            {modal.actions.map((a, i) => (
              <button
                key={i}
                className="btn"
                onClick={a.onClick}
                style={{
                  fontSize: 13.5,
                  fontWeight: a.kind === 'danger' ? 600 : 400,
                  background: a.kind === 'danger' ? '#DC2626' : a.kind === 'primary' ? '#051747' : 'transparent',
                  color: a.kind === 'danger' || a.kind === 'primary' ? '#fff' : 'var(--color-text)',
                  borderColor: a.kind === 'danger' ? '#DC2626' : a.kind === 'primary' ? '#051747' : 'var(--color-neutral-400)',
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    ) : null;

  const renderToast = () =>
    toast ? (
      <div style={{ position: preview ? 'absolute' : 'fixed', left: '50%', bottom: 104, transform: 'translateX(-50%)', zIndex: 70, padding: '11px 18px', borderRadius: 999, background: '#050f2b', color: '#fff', fontSize: 13, whiteSpace: 'nowrap', boxShadow: 'var(--shadow-lg)' }}>
        {toast}
      </div>
    ) : null;

  const renderBody = () => {
    if (!preview && loadState === 'loading') {
      return (
        <div style={{ minHeight: preview ? 844 : '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <span className="text-muted" style={{ fontSize: 14 }}>Loading this week&apos;s menu…</span>
        </div>
      );
    }
    if (!preview && loadState === 'error') {
      return (
        <div style={{ minHeight: preview ? 844 : '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 28px', textAlign: 'center' }}>
          <MatterLogo height={24} style={{ marginBottom: 24 }} />
          <h2 style={{ margin: '0 0 10px' }}>Link unavailable</h2>
          <p className="text-muted" style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>{loadError}</p>
        </div>
      );
    }
    return (
      <>
        {step === 'signin' && renderSignIn()}
        {step === 'menu' && account && renderMenu()}
        {step === 'done' && renderDone()}
      </>
    );
  };

  return (
    <div className="msl" style={OUTER}>
      <div>
        {preview ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, width: 390, margin: '0 auto 12px' }}>
            <span style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-neutral-600)' }}>
              Customer link preview
            </span>
            <button className="btn btn-secondary" onClick={resetAll} style={{ fontSize: 12, padding: '6px 12px' }}>Restart</button>
          </div>
        ) : null}

        <div style={FRAME}>
          <div ref={phoneRef} className="msl-phone" style={{ height: preview ? '100%' : 'auto', overflowY: preview ? 'auto' : 'visible' }}>
            {renderBody()}
          </div>
          {renderModal()}
          <SkipPauseCalendarModal
            open={!!skipPauseReview}
            loading={pausePreviewLoading}
            pauses={skipPauseReview?.pauses || []}
            submitting={submitting}
            preview={preview}
            weekendEnabled={skipPauseReview?.weekendEnabled ?? !!account?.weekend}
            submissionError={skipPauseReview?.submissionError}
            activeDeliveryDates={skipPauseReview?.activeDeliveryDates || []}
            unavailableDates={skipPauseReview?.unavailableDates || []}
            availabilityError={skipPauseReview?.availabilityError}
            onCancel={handleCancelPauseReview}
            onConfirm={handleConfirmPauseReview}
          />
          {renderToast()}
        </div>
      </div>
    </div>
  );
};

export default MenuSelectionLink;
export { buildRealModel, expandSaturdaySkips };
