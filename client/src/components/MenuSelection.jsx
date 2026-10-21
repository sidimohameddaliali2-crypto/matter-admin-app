import React, { useState, useEffect, useMemo } from 'react';
import { Mail, ChevronRight, ChevronLeft, Check, AlertCircle, Loader, X, UtensilsCrossed, Eye, EyeOff, Pencil, Copy } from 'lucide-react';
import api from '../utils/api';
import { calculateCalories, distributeMacros, lookupProteinWeight, lookupCarbWeight } from '../utils/nutrition';
import { groupExclusions, exclusionMatchesTerm } from '../constants/exclusionList';

// portion/carb/vegIngredients are tagged [{name, visible}] lists set in the
// meal editor — only ingredients marked visible are ever shown here; hidden
// ones still feed allergen/exclusion matching (see allergenBlockedIds) but
// never reach this display.
const visibleIngredientNames = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((t) => t?.visible !== false)
    .map((t) => t?.name)
    .filter(Boolean)
    .join(', ');

const MenuSelection = ({ token }) => {
  const [step, setStep] = useState('email'); // email, loading, meals, complete
  const [email, setEmail] = useState('');
  const [customerProfile, setCustomerProfile] = useState(null);
  const [weeklyMenu, setWeeklyMenu] = useState(null);
  const [selectedMeals, setSelectedMeals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mealIndex, setMealIndex] = useState(0);
  const [showExclusionModal, setShowExclusionModal] = useState(false);
  const [pendingSelection, setPendingSelection] = useState(null);
  const [acknowledgeExclusion, setAcknowledgeExclusion] = useState(false);
  const [showCarbVegModal, setShowCarbVegModal] = useState(false);
  const [pendingCarbVegPayload, setPendingCarbVegPayload] = useState(null);
  const [showKeepOrReplaceModal, setShowKeepOrReplaceModal] = useState(false);
  const [showBreakfastModal, setShowBreakfastModal] = useState(false);
  const [pendingBreakfastSelection, setPendingBreakfastSelection] = useState(null);
  const [acknowledgeBreakfast, setAcknowledgeBreakfast] = useState(false);
  // remember if user has seen/accepted the breakfast disclaimer this session
  const [breakfastDisclaimerShown, setBreakfastDisclaimerShown] = useState(false);
  const [showRemainingModal, setShowRemainingModal] = useState(false);
  const [remainingCount, setRemainingCount] = useState(0);
  const [pendingNavAction, setPendingNavAction] = useState(null);
  const [inlineLimitError, setInlineLimitError] = useState(null);
  const [acknowledgeRemaining, setAcknowledgeRemaining] = useState(false);
  const [showNoSelectionModal, setShowNoSelectionModal] = useState(false);
  const [visibleDietaryDetails, setVisibleDietaryDetails] = useState({});
  const [skippedDateKeys, setSkippedDateKeys] = useState([]);
  const [showIngredientModal, setShowIngredientModal] = useState(false);
  const [activeIngredientSlot, setActiveIngredientSlot] = useState(null);
  const [ingredientSelectionDraft, setIngredientSelectionDraft] = useState({
    protein: '',
    veg: '',
    carb: '',
    sauce: ''
  });
  const [showCopyDayModal, setShowCopyDayModal] = useState(false);
  const [copyTargets, setCopyTargets] = useState({});
  const [copyError, setCopyError] = useState(null);
  const [allergenBlockData, setAllergenBlockData] = useState(null);
  const [showMacrosModal, setShowMacrosModal] = useState(false);
  const [macrosInput, setMacrosInput] = useState({ C: '', P: '', F: '' });
  const [breakfastPreset, setBreakfastPreset] = useState({ C: '', P: '', F: '' });
  const [snackPreset, setSnackPreset] = useState({ C: '', P: '', F: '' });
  const [macrosPreview, setMacrosPreview] = useState(null);
  const [isSavingMacros, setIsSavingMacros] = useState(false);

  const formatValue = (value) => {
    if (!value) return 'None';
    const items = String(value)
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const lower = item.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      });

    return items.length > 0 ? items.join(', ') : 'None';
  };

  const formatTitle = (value) => {
    if (!value) return '';
    const lower = String(value).trim().toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  };

  const parseLocalDate = (value) => {
    if (!value) return null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }

    const text = String(value);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      return new Date(year, month - 1, day);
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  };

  const formatLocalDate = (value, options) => {
    const localDate = parseLocalDate(value);
    if (!localDate) return 'Invalid date';
    return localDate.toLocaleDateString('en-US', options);
  };

  const getDateKey = (value) => {
    if (!value) return '';
    const date = parseLocalDate(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const displayRange = useMemo(() => {
    const mealDateKeys = Array.isArray(weeklyMenu?.meals)
      ? Array.from(
          new Set(
            weeklyMenu.meals
              .map((meal) => getDateKey(meal?.date))
              .filter(Boolean)
          )
        ).sort()
      : [];

    if (mealDateKeys.length > 0) {
      return {
        start: mealDateKeys[0],
        end: mealDateKeys[mealDateKeys.length - 1]
      };
    }

    return {
      start: weeklyMenu?.startDate,
      end: weeklyMenu?.endDate
    };
  }, [weeklyMenu, customerProfile?.weekend]);

  /**
   * Returns true if the given delivery date is past its selection deadline.
   * The deadline is computed as: deliveryDate - daysBefore days at deadlineTime.
   */
  const isDayLocked = (deliveryDateValue) => {
    const deadlines = weeklyMenu?.selectionDeadlines;
    const deliveryDate = parseLocalDate(deliveryDateValue);
    if (!deliveryDate) return false;

    // When no deadlines are configured, fall back to whether the date is in the past.
    if (!Array.isArray(deadlines) || deadlines.length === 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return deliveryDate < today;
    }

    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const deliveryDayName = DAY_NAMES[deliveryDate.getDay()];

    const rule = deadlines.find(d => d.deliveryDay === deliveryDayName);
    if (!rule) {
      // No rule for this day — fall back to past-date check
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return deliveryDate < today;
    }

    // Compute absolute deadline moment
    const deadlineDateLocal = new Date(
      deliveryDate.getFullYear(),
      deliveryDate.getMonth(),
      deliveryDate.getDate() - (rule.daysBefore || 0)
    );
    const [hh, mm] = String(rule.deadlineTime || '23:59').split(':').map(Number);
    deadlineDateLocal.setHours(hh, mm, 59, 999);

    return new Date() > deadlineDateLocal;
  };

  useEffect(() => {
    // Fetch weekly menu by share token
    const fetchMenu = async () => {
      try {
        const response = await api.get(`/menus/share/${token}`);
        if (response.data?.success) {
          console.log('Fetched menu:', response.data.data);
          console.log('enableCompletionMessage:', response.data.data?.enableCompletionMessage);
          console.log('completionMessage:', response.data.data?.completionMessage);
          setWeeklyMenu(response.data.data);
        }
      } catch (err) {
        console.error('Error fetching menu:', err);
        setError(err.response?.data?.message || 'Menu not found or share link has expired');
      }
    };

    fetchMenu();
  }, [token]);

  // Load customer profile by email (used by form submit and URL prefill)
  const fetchProfileByEmail = async (emailToLoad) => {
    if (!emailToLoad) return null;
    const trimmed = String(emailToLoad).trim();
    if (trimmed === '') return null;

    setLoading(true);
    setError(null);

    try {
      const menuIdParam = weeklyMenu?._id ? `&menuId=${encodeURIComponent(weeklyMenu._id)}` : '';
      const response = await api.get(
        `/menus/customers/${encodeURIComponent(trimmed)}/subscription-profile?email=${encodeURIComponent(trimmed)}${menuIdParam}`
      );

      if (response.data?.success) {
        const profile = response.data.data;
        setCustomerProfile(profile);
        let loadedMeals = [];

        if (profile.selectedMeals && Array.isArray(profile.selectedMeals)) {
          const consolidatedMap = new Map();
          profile.selectedMeals.forEach(meal => {
            const dateKey = getDateKey(meal.date) || '';
            const itemIdStr = meal.menuItemId ? String(meal.menuItemId._id || meal.menuItemId) : '';
            const key = `${dateKey}||${itemIdStr}`;
            if (consolidatedMap.has(key)) {
              const existing = consolidatedMap.get(key);
              existing.quantity = (existing.quantity || 1) + (meal.quantity || 1);
            } else {
              consolidatedMap.set(key, {
                date: dateKey,
                mealType: meal.mealType,
                menuItemId: meal.menuItemId,
                mealName: meal.mealName,
                description: meal.description,
                slotNumber: meal.slotNumber,
                proteinChoice: meal.proteinChoice,
                vegChoice: meal.vegChoice,
                carbChoice: meal.carbChoice,
                sauceChoice: meal.sauceChoice,
                quantity: meal.quantity || 1
              });
            }
          });
          loadedMeals = Array.from(consolidatedMap.values());
        }

        setSelectedMeals(loadedMeals);
        setStep('meals');
        return profile;
      }
    } catch (err) {
      console.error('Error fetching meal profile:', err);
      setError(err.response?.data?.message || 'Failed to load meal preferences');
    } finally {
      setLoading(false);
    }

    return null;
  };

  useEffect(() => {
    // If URL contains ?email=..., auto-load that customer after menu is fetched
    if (!weeklyMenu) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const prefillEmail = params.get('email');
      if (prefillEmail && !customerProfile) {
        setEmail(prefillEmail);
        fetchProfileByEmail(prefillEmail);
      }
    } catch (e) {
      // ignore URL parsing issues
    }

    const link = document.querySelector("link[rel~='icon']");
    if (!link) return;
    const previousHref = link.getAttribute('href');
    link.setAttribute('href', '/images/favicon.ico');

    return () => {
      if (previousHref) {
        link.setAttribute('href', previousHref);
      }
    };
  }, [weeklyMenu]);

  useEffect(() => {
    if (!inlineLimitError) return;
    // Menu-selection Partner members (Customer.unlimitedMeals) have no daily cap.
    const maxPerDay = customerProfile?.unlimitedMeals ? Infinity : (Number(customerProfile?.mealPerDay) || 1);
    const errorDate = inlineLimitError.dateKey;
    if (!errorDate) return;

    const selectedForDate = selectedMeals.filter((m) => m.date === errorDate);
    const countedMeals = selectedForDate
      .reduce((sum, m) => sum + (m.quantity || 1), 0);

    if (inlineLimitError.type === 'meal' && countedMeals < maxPerDay) {
      setInlineLimitError(null);
    }

    if (inlineLimitError.type === 'breakfast') {
      const hasBreakfast = selectedForDate.some(
        (m) => String(m.mealType || '').toLowerCase() === 'breakfast'
      );
      if (!hasBreakfast) {
        setInlineLimitError(null);
      }
    }
  }, [inlineLimitError, selectedMeals, customerProfile]);


  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    if (!email) return;

    const trimmed = email.trim();
    if (trimmed === '') return;

    setLoading(true);
    setError(null);

    try {
      // Fetch customer profile from email.
      // Pass menuId so the server returns this specific menu's historical selections
      // (from MenuSelectionRecord) rather than the customer's latest selections.
      const menuIdParam = weeklyMenu?._id ? `&menuId=${encodeURIComponent(weeklyMenu._id)}` : '';
      const response = await api.get(
        `/menus/customers/${encodeURIComponent(trimmed)}/subscription-profile?email=${encodeURIComponent(trimmed)}${menuIdParam}`
      );

      if (response.data?.success) {
        const profile = response.data.data;
        setCustomerProfile(profile);
        let loadedMeals = [];
        
        // Load existing selections if they exist
        if (profile.selectedMeals && Array.isArray(profile.selectedMeals)) {
          // Consolidate duplicate selections (for backward compatibility with old data)
          const consolidatedMap = new Map();
          
          profile.selectedMeals.forEach(meal => {
            const dateKey = getDateKey(meal.date) || '';
            // Safe conversion of menuItemId to string for comparing
            const itemIdStr = meal.menuItemId 
              ? String(meal.menuItemId._id || meal.menuItemId) 
              : '';
            const key = `${dateKey}||${itemIdStr}`;
            
            if (consolidatedMap.has(key)) {
              // Add to existing entry's quantity
              const existing = consolidatedMap.get(key);
              existing.quantity = (existing.quantity || 1) + (meal.quantity || 1);
            } else {
              // Create new entry
              consolidatedMap.set(key, {
                date: dateKey,
                mealType: meal.mealType,
                menuItemId: itemIdStr || undefined,
                mealName: meal.mealName,
                quantity: meal.quantity || 1,
                slotNumber: meal.slotNumber,
                proteinChoice: meal.proteinChoice,
                vegChoice: meal.vegChoice,
                carbChoice: meal.carbChoice,
                sauceChoice: meal.sauceChoice
              });
            }
          });
          
          loadedMeals = Array.from(consolidatedMap.values());
          setSelectedMeals(loadedMeals);
        } else {
          setSelectedMeals([]);
        }

        // Go to "All Set" only when the server confirmed a real submission record
        // exists for THIS specific menu. Never auto-complete based on selections
        // that may belong to a different menu (the fallback path).
        if (profile.hasSubmittedForRequestedMenu === true && loadedMeals.length > 0) {
          setStep('complete');
        } else {
          const hasSelections = loadedMeals.length > 0;
          // isSameMenu must be strict: only true when currentWeekMenu is explicitly
          // set to this menu. A missing currentWeekMenu means new/unsubmitted customer.
          const isSameMenu = profile.currentWeekMenu && weeklyMenu?._id
            ? String(profile.currentWeekMenu) === String(weeklyMenu._id)
            : false;

          if (hasSelections && isSameMenu) {
            setStep('complete');
          } else {
            // Not the same menu — discard any pre-loaded selections so the
            // customer starts fresh and doesn't hit a false per-day limit.
            setSelectedMeals([]);
            setStep('meals');
          }
        }
      }
    } catch (err) {
      console.error('Error fetching profile:', err);
      setError(
        err.response?.data?.message ||
        'Could not find customer profile. Please try another email.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleMealSelect = (mealItemId, mealEntry) => {
    // Allergen hard-block (customer's real allergy list) is separate from all
    // of this, checked first, and unaffected by any of the exclusion routing
    // below — see allergenBlockedIds.
    const _blockCheck = String(mealItemId || '');
    if (allergenBlockedIds.has(_blockCheck)) return;
    if (showExclusionModal || showRemainingModal || showBreakfastModal || showCarbVegModal || showKeepOrReplaceModal) return;
    setInlineLimitError(null);
    const currentMeal = mealEntry || filteredMeals[mealIndex];
    if (!currentMeal?.date) return;
    if (isDayLocked(currentMeal.date)) return; // deadline passed

    const getTokens = (value) => String(value || '')
      .split(/[,;|\n\r]/)
      .map((item) => item.trim())
      .filter(Boolean);
    // portion/carb/vegIngredients are tagged [{name, visible}] lists — every
    // ingredient is checked here regardless of its visible flag.
    const getTagNames = (list) => (Array.isArray(list) ? list : []).map((t) => t?.name).filter(Boolean);

    const normalizeToken = (value) => String(value || '').trim().toLowerCase();
    // exclusionMatchesTerm covers both an exact match and umbrella groups
    // like "All Nuts"/"All Fish" (see constants/exclusionList.js) — a
    // customer excluding "All Nuts" is caught by an ingredient named
    // "almond", not just one literally named "nuts".
    const matchAgainstExclusions = (rawTerms, exclusions) => rawTerms.filter((term) =>
      exclusions.some((ex) => exclusionMatchesTerm(ex, term))
    );

    const selectedItem = currentMeal?.items?.find(item => String(item._id) === String(mealItemId));
    const exclusionsRaw = groupExclusions(customerProfile?.mealExclusion);
    const exclusions = exclusionsRaw.map(normalizeToken);

    const selectionKeyDate = getDateKey(currentMeal.date);
    const existingSelection = selectedMeals.find(
      (m) => m.date === selectionKeyDate && m.menuItemId === mealItemId
    );

    // Component-specific exclusion routing:
    //  - portion match  -> full "Exclusion Alert" modal (customer sees it)
    //  - carb/veg match -> "change carb"/"change veg" modal (customer sees it)
    //  - sauce/garnish match -> no customer-facing message at all; just a
    //    backend flag (needsSauceChange/needsGarnishChange) for Kitchen List.
    let matchedPortion = [];
    let hasConflict = false;
    let matchedCarbItems = [];
    let matchedVegItems = [];
    let hasCarbVegConflict = false;
    let matchedSauce = [];
    let matchedGarnish = [];
    if (!existingSelection && exclusions.length > 0) {
      matchedPortion = matchAgainstExclusions(getTagNames(selectedItem?.portionIngredients), exclusions);
      hasConflict = matchedPortion.length > 0;

      matchedCarbItems = matchAgainstExclusions(getTagNames(selectedItem?.carbIngredients), exclusions);
      matchedVegItems = matchAgainstExclusions(getTagNames(selectedItem?.vegIngredients), exclusions);
      hasCarbVegConflict = matchedCarbItems.length > 0 || matchedVegItems.length > 0;

      matchedSauce = matchAgainstExclusions(getTagNames(selectedItem?.sauceIngredients), exclusions);
      matchedGarnish = matchAgainstExclusions(getTokens(selectedItem?.garnish), exclusions);
    }
    const sauceGarnishFlags = {
      needsSauceChange: matchedSauce.length > 0,
      needsGarnishChange: matchedGarnish.length > 0,
      sauceConflict: matchedSauce,
      garnishConflict: matchedGarnish
    };

    const isBreakfast = String(currentMeal.mealType || '').toLowerCase() === 'breakfast';
    if (
      !existingSelection &&
      isBreakfast &&
      !customerProfile?.breakfastInclude &&
      !breakfastDisclaimerShown
    ) {
      setPendingBreakfastSelection({
        mealItemId,
        currentMeal,
        selectedItem,
        exclusions: matchedPortion,
        hasConflict,
        hasCarbVegConflict,
        matchedCarbItems,
        matchedVegItems,
        ...sauceGarnishFlags
      });
      setAcknowledgeBreakfast(false);
      setShowBreakfastModal(true);
      return;
    }

    if (hasConflict) {
      setPendingSelection({
        mealItemId,
        currentMeal,
        selectedItem,
        exclusions: matchedPortion,
        ...sauceGarnishFlags
      });
      setAcknowledgeExclusion(false);
      setShowExclusionModal(true);
      return;
    }

    if (hasCarbVegConflict) {
      setPendingCarbVegPayload({
        mealItemId,
        currentMeal,
        selectedItem,
        matchedCarbItems,
        matchedVegItems,
        ...sauceGarnishFlags
      });
      setAcknowledgeExclusion(false);
      setShowCarbVegModal(true);
      return;
    }

    proceedWithSelection({
      currentMeal,
      mealItemId,
      selectedItem,
      ...sauceGarnishFlags
    });
  };

  const handleMealDecrement = (mealItemId, mealEntry) => {
    if (showExclusionModal || showRemainingModal || showBreakfastModal || showCarbVegModal || showKeepOrReplaceModal) return;
    const _blockCheck = String(mealItemId || '');
    if (allergenBlockedIds.has(_blockCheck)) return;
    const currentMeal = mealEntry || filteredMeals[mealIndex];
    if (!currentMeal?.date) return;
    if (isDayLocked(currentMeal.date)) return; // deadline passed

    const selectionKeyDate = getDateKey(currentMeal.date);
    const itemIdStr = String(mealItemId || '');
    setInlineLimitError(null);
    setSelectedMeals((prev) =>
      prev
        .map((m) => {
          const mIdStr = String(m.menuItemId || '');
          if (m.date === selectionKeyDate && mIdStr === itemIdStr) {
            const nextQuantity = (m.quantity || 1) - 1;
            return { ...m, quantity: nextQuantity };
          }
          return m;
        })
        .filter((m) => (m.quantity ?? 0) > 0)
    );
  };

  const handleBreakfastConfirm = (payload) => {
    if (!payload) return;
    const {
      mealItemId, currentMeal, selectedItem, exclusions, hasConflict, hasCarbVegConflict, matchedCarbItems, matchedVegItems,
      needsSauceChange, needsGarnishChange, sauceConflict, garnishConflict
    } = payload;
    const sauceGarnishFlags = { needsSauceChange, needsGarnishChange, sauceConflict, garnishConflict };

    setShowBreakfastModal(false);
    setPendingBreakfastSelection(null);
    setAcknowledgeBreakfast(false);
    setBreakfastDisclaimerShown(true);

    if (hasConflict) {
      setPendingSelection({ mealItemId, currentMeal, selectedItem, exclusions, ...sauceGarnishFlags });
      setAcknowledgeExclusion(false);
      setShowExclusionModal(true);
      return;
    }

    if (hasCarbVegConflict) {
      setPendingCarbVegPayload({ mealItemId, currentMeal, selectedItem, matchedCarbItems, matchedVegItems, ...sauceGarnishFlags });
      setAcknowledgeExclusion(false);
      setShowCarbVegModal(true);
      return;
    }

    proceedWithSelection(payload);
  };

  const proceedWithSelection = (payload, carbVegAction = null) => {
    const currentMeal = payload?.currentMeal || filteredMeals[mealIndex];
    const mealItemId = payload?.mealItemId;
    if (!currentMeal?.date || !mealItemId) return;

    // Menu-selection Partner members (Customer.unlimitedMeals) have no daily cap.
    const maxPerDay = customerProfile?.unlimitedMeals ? Infinity : (Number(customerProfile?.mealPerDay) || 1);
    const selectionKeyDate = getDateKey(currentMeal.date);
    const isBreakfast = String(currentMeal.mealType || '').toLowerCase() === 'breakfast';

    setSelectedMeals((prev) => {
      const itemIdStr = String(mealItemId || '');
      const existing = prev.find(
        (m) => m.date === selectionKeyDate && String(m.menuItemId || '') === itemIdStr
      );

      const selectedForDate = prev.filter((m) => m.date === selectionKeyDate);
      const countedMeals = selectedForDate
        .reduce((sum, m) => sum + (m.quantity || 1), 0);

      // total of all meals+breakfasts counts toward the limit
      if (countedMeals >= maxPerDay) {
        setInlineLimitError({
          mealItemId,
          dateKey: selectionKeyDate,
          type: 'meal',
          message: `You can select up to ${maxPerDay} meals (including breakfast) for this day.`
        });
        return prev;
      }
      // no separate breakfast limit any more

      setInlineLimitError(null);

      if (existing) {
        const newQuantity = (existing.quantity || 1) + 1;
        return prev.map((m) =>
          m === existing ? { ...m, quantity: newQuantity } : m
        );
      }

      return [
        ...prev,
        {
          date: selectionKeyDate,
          mealType: currentMeal.mealType,
          menuItemId: String(mealItemId),
          mealName: currentMeal?.items?.find(item => String(item._id) === String(mealItemId))?.mealName,
          quantity: 1,
          ...(carbVegAction ? {
            carbVegAction,
            carbVegConflict: [...(payload.matchedCarbItems || []), ...(payload.matchedVegItems || [])],
            carbConflict: payload.matchedCarbItems || [],
            vegConflict: payload.matchedVegItems || []
          } : {}),
          // Sauce/garnish exclusion matches never block or prompt the
          // customer — the meal is added normally either way, this just
          // carries the flag through to Kitchen List for staff.
          ...(payload.needsSauceChange || payload.needsGarnishChange ? {
            needsSauceChange: !!payload.needsSauceChange,
            needsGarnishChange: !!payload.needsGarnishChange,
            sauceConflict: payload.sauceConflict || [],
            garnishConflict: payload.garnishConflict || []
          } : {})
        }
      ];
    });

    setSkippedDateKeys((prev) => prev.filter((key) => key !== selectionKeyDate));
  };

  const getRemainingForDate = (dateValue) => {
    // Unlimited customers never get nagged to "pick N more" — there's no quota to hit.
    if (customerProfile?.unlimitedMeals) return 0;
    const maxPerDay = Number(customerProfile?.mealPerDay) || 1;
    const selectedForDate = selectedMeals.filter((m) => m.date === getDateKey(dateValue));
    const countedMeals = selectedForDate
      .reduce((sum, m) => sum + (m.quantity || 1), 0);
    return Math.max(0, maxPerDay - countedMeals);
  };

  const handleNext = () => {
    if (showExclusionModal || showRemainingModal || showCarbVegModal || showKeepOrReplaceModal) return;
    const remaining = getRemainingForDate(currentDateGroup?.date);

    if (remaining > 0) {
      setRemainingCount(remaining);
      setPendingNavAction('next');
      setShowRemainingModal(true);
      return;
    }

    setMealIndex(Math.min(dateGroups.length - 1, mealIndex + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePrevious = () => {
    if (dateGroups.length === 0) return;
    setMealIndex(Math.max(0, mealIndex - 1));
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const handleNoSelection = () => {
    if (mealIndex === dateGroups.length - 1) {
      handleConfirmNoSelection();
    } else {
      setShowNoSelectionModal(true);
    }
  };

  const handleConfirmNoSelection = () => {
    setShowNoSelectionModal(false);
    const currentDateKey = getDateKey(currentDateGroup?.date);
    if (currentDateKey) {
      setSkippedDateKeys((prev) => (prev.includes(currentDateKey) ? prev : [...prev, currentDateKey]));
    }
    // Skip to next day
    if (mealIndex < dateGroups.length - 1) {
      setMealIndex(mealIndex + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      // Last day — auto-submit if they have meals on other days, otherwise scroll to submit button.
      // Pass the just-skipped key explicitly: the setSkippedDateKeys above hasn't
      // flushed yet when submitSelections reads state in this same tick.
      if (selectedMeals.length > 0) {
        submitSelections(currentDateKey ? [currentDateKey] : []);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  };

  const handleContinueAnyway = () => {
    setShowRemainingModal(false);
    setAcknowledgeRemaining(false);
    const action = pendingNavAction;
    setPendingNavAction(null);

    if (action === 'submit') {
      submitSelections();
      return;
    }

    if (action === 'next') {
      const targetIndex = Math.min(dateGroups.length - 1, mealIndex + 1);
      setMealIndex(targetIndex);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const submitSelections = async (extraSkippedKeys = []) => {
    setLoading(true);
    setError(null);

    const trimmed = email.trim();

    console.log('=== SUBMITTING SELECTIONS ===');
    console.log('Total selections:', selectedMeals.length);
    console.log('Selections:', JSON.stringify(selectedMeals, null, 2));
    const totalWithQty = selectedMeals.reduce((sum, m) => sum + (m.quantity || 1), 0);
    console.log('Total meals (with quantity):', totalWithQty);

    try {
      // include macros if set
      const mealCount = totalWithQty;
      let macrosPayload = null;
      if (macrosPreview) {
        macrosPayload = macrosPreview;
      } else if ((macrosInput.C || macrosInput.P || macrosInput.F)) {
        const c = Number(macrosInput.C) || 0;
        const p = Number(macrosInput.P) || 0;
        const f = Number(macrosInput.F) || 0;
        const calories = calculateCalories({ C: c, P: p, F: f });
        const distributed = distributeMacros({ C: c, P: p, F: f }, mealCount, []);
        macrosPayload = { total: { C: c, P: p, F: f, calories }, presets: { breakfast: breakfastPreset, snack: snackPreset }, perMeal: distributed.perMeal };
      }

      const body = { weeklyMenuId: weeklyMenu._id, selections: selectedMeals };
      if (macrosPayload) body.macros = macrosPayload;
      // Days the customer chose to skip — the server pauses each on their Matter
      // subscription and reschedules it after the cycle end. Not surfaced here.
      const allSkipped = Array.from(new Set([...skippedDateKeys, ...extraSkippedKeys])).filter(Boolean);
      if (allSkipped.length > 0) body.skippedDates = allSkipped;

      const response = await api.post(`/menus/customers/${encodeURIComponent(trimmed)}/select-meals`, body);

      if (response.data?.success) {
        setStep('complete');
      }
    } catch (err) {
      console.error('Error submitting selections:', err);
      setError(err.response?.data?.message || 'Failed to save meal selections');
    } finally {
      setLoading(false);
    }
  };

  // Macros helpers
  const computeMacrosPreview = () => {
    const c = Number(macrosInput.C) || 0;
    const p = Number(macrosInput.P) || 0;
    const f = Number(macrosInput.F) || 0;
    const calories = calculateCalories({ C: c, P: p, F: f });
    const totalMeals = selectedMeals.reduce((sum, m) => sum + (m.quantity || 1), 0) || 1;
    const presets = [];
    if ((Number(breakfastPreset.C) || Number(breakfastPreset.P) || Number(breakfastPreset.F))) presets.push(breakfastPreset);
    if ((Number(snackPreset.C) || Number(snackPreset.P) || Number(snackPreset.F))) presets.push(snackPreset);
    const distributed = distributeMacros({ C: c, P: p, F: f }, totalMeals, presets);
    setMacrosPreview({ total: { C: c, P: p, F: f, calories }, presets, perMeal: distributed.perMeal });
  };

  const handleSaveMacros = () => {
    setIsSavingMacros(true);
    try {
      computeMacrosPreview();
      setShowMacrosModal(false);
    } finally {
      setIsSavingMacros(false);
    }
  };

  const handleSubmit = () => {
    if (showExclusionModal || showRemainingModal || showCarbVegModal || showKeepOrReplaceModal) return;
    const remaining = getRemainingForDate(currentDateGroup?.date);

    if (remaining > 0) {
      setRemainingCount(remaining);
      setPendingNavAction('submit');
      setShowRemainingModal(true);
      return;
    }

    submitSelections();
  };

  const filteredMeals = useMemo(() => {
    if (!weeklyMenu?.meals) return [];
    return weeklyMenu.meals.filter((meal) => {
      const mealType = (meal?.mealType || '').toLowerCase();
      if (mealType === 'snack') return false;
      // Exclude weekend days (Saturday=6, Sunday=0) unless customer's profile enables weekend
      const weekendEnabled = !!customerProfile?.weekend;
      const date = parseLocalDate(meal?.date);
      if (date && !weekendEnabled) {
        const day = date.getDay();
        if (day === 0 || day === 6) return false;
      }
      return true;
    });
  }, [weeklyMenu, customerProfile?.weekend]);

  const isBodybuilderFlow = useMemo(() => {
    const customerPlan = String(customerProfile?.mealPlan || '').toLowerCase();
    const menuPlans = Array.isArray(weeklyMenu?.mealPlans)
      ? weeklyMenu.mealPlans.map((p) => String(p || '').toLowerCase())
      : [];
    return customerPlan === 'bodybuilder' || menuPlans.includes('bodybuilder');
  }, [customerProfile?.mealPlan, weeklyMenu?.mealPlans]);

  // Compute which meal item IDs are hard-blocked for this customer based on allergens.
  // Checks item.allergens, item.carbs, and item.veg against customer's allergies list —
  // same breadth as the exclusion system but results in a hard block, not a soft warning.
  const allergenBlockedIds = useMemo(() => {
    const blocked = new Map(); // itemId -> matchedTokens[]
    const customerAllergies = Array.isArray(customerProfile?.allergies)
      ? customerProfile.allergies.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (customerAllergies.length === 0 || !weeklyMenu?.meals) return blocked;

    const splitTokens = (value) =>
      String(value || '')
        .split(/[,;|\n\r]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    // portion/carb/vegIngredients are tagged [{name, visible}] lists — every
    // ingredient is checked here regardless of its visible flag, since
    // hiding an ingredient from the customer must never hide it from an
    // allergy check.
    const tagTokens = (list) =>
      (Array.isArray(list) ? list : []).map((t) => String(t?.name || '').trim().toLowerCase()).filter(Boolean);

    weeklyMenu.meals.forEach((meal) => {
      (meal.items || []).forEach((item) => {
        const itemId = String(item._id || '');
        if (!itemId) return;
        const allergenTokens = splitTokens(
          Array.isArray(item.allergens) ? item.allergens.join(',') : item.allergens
        );
        // Also scan intolerances so allergen hard-block wins even when
        // content was entered in the intolerances (soft-warning) field.
        const intoleranceTokens = splitTokens(item.intolerances);
        // proteinSource/carbs/veg/sauce hold the searched recipe's own name
        // (what the customer sees) — the portion/carb/veg/sauceIngredients
        // fields hold that recipe's actual ingredient names, which is what
        // actually needs checking against a customer's allergies.
        const proteinTokens = [...splitTokens(item.proteinSource), ...tagTokens(item.portionIngredients)];
        const carbTokens = [...splitTokens(item.carbs), ...tagTokens(item.carbIngredients)];
        const vegTokens = [...splitTokens(item.veg), ...tagTokens(item.vegIngredients)];
        const sauceTokens = [...splitTokens(item.sauce), ...tagTokens(item.sauceIngredients)];
        const allTokens = [...allergenTokens, ...intoleranceTokens, ...proteinTokens, ...carbTokens, ...vegTokens, ...sauceTokens];
        const matched = allTokens.filter((token) => customerAllergies.includes(token));
        if (matched.length > 0) {
          blocked.set(itemId, matched);
        }
      });
    });
    return blocked;
  }, [customerProfile?.allergies, weeklyMenu]);

  const splitIngredientTokens = (value) => String(value || '')
    .split(/[,;|\n\r]/)
    .map((part) => part.trim())
    .filter(Boolean);

  const getIngredientOptionsForEntries = (entries = []) => {
    const protein = new Set();
    const veg = new Set();
    const carb = new Set();
    const sauce = new Set();

    entries.forEach((mealEntry) => {
      (mealEntry?.items || []).forEach((item) => {
        splitIngredientTokens(item?.proteinSource).forEach((token) => protein.add(token));
        splitIngredientTokens(item?.veg).forEach((token) => veg.add(token));
        splitIngredientTokens(item?.carbs).forEach((token) => carb.add(token));
        splitIngredientTokens(item?.sauce).forEach((token) => sauce.add(token));
      });
    });

    return {
      protein: Array.from(protein),
      veg: Array.from(veg),
      carb: Array.from(carb),
      sauce: Array.from(sauce)
    };
  };

  const dateGroups = useMemo(() => {
    const groups = [];
    const groupMap = new Map();
    filteredMeals.forEach((meal) => {
      const key = getDateKey(meal?.date);
      if (!groupMap.has(key)) {
        const nextGroup = {
          date: meal?.date,
          dateKey: key,
          entries: []
        };
        groupMap.set(key, nextGroup);
        groups.push(nextGroup);
      }
      groupMap.get(key).entries.push(meal);
    });
    return groups;
  }, [filteredMeals]);

  useEffect(() => {
    if (dateGroups.length === 0) {
      setMealIndex(0);
      return;
    }

    if (mealIndex > dateGroups.length - 1) {
      setMealIndex(dateGroups.length - 1);
    }
  }, [dateGroups.length, mealIndex]);

  // When the customer first reaches the meals step, jump to the first available (non-locked) day.
  useEffect(() => {
    if (step !== 'meals' || dateGroups.length === 0) return;
    const firstAvailableIndex = dateGroups.findIndex((group) => !isDayLocked(group.date));
    if (firstAvailableIndex > 0) {
      setMealIndex(firstAvailableIndex);
    }
  }, [step]); // eslint-disable-line

  const currentDateGroup = dateGroups[mealIndex];
  const currentDateMeals = currentDateGroup?.entries || [];
  const currentMainMeals = currentDateMeals.filter(
    (meal) => String(meal?.mealType || '').toLowerCase() !== 'breakfast'
  );
  const currentBreakfastMeals = currentDateMeals.filter(
    (meal) => String(meal?.mealType || '').toLowerCase() === 'breakfast'
  );
  const currentIngredientOptions = getIngredientOptionsForEntries(currentMainMeals);

  const handleIngredientSlotOpen = (slotNumber) => {
    if (!currentDateGroup?.date) return;
    const dateKey = getDateKey(currentDateGroup.date);
    const existing = selectedMeals.find(
      (m) => m.date === dateKey && Number(m.slotNumber) === Number(slotNumber)
    );

    setActiveIngredientSlot(slotNumber);
    setIngredientSelectionDraft({
      protein: existing?.proteinChoice || '',
      veg: existing?.vegChoice || '',
      carb: existing?.carbChoice || '',
      sauce: existing?.sauceChoice || ''
    });
    setShowIngredientModal(true);
  };

  const handleIngredientSlotConfirm = () => {
    if (!currentDateGroup?.date || !activeIngredientSlot) return;
    if (!ingredientSelectionDraft.protein || !ingredientSelectionDraft.veg || !ingredientSelectionDraft.carb) return;

    const dateKey = getDateKey(currentDateGroup.date);
    const fallbackItemId = currentMainMeals?.[0]?.items?.[0]?._id;
    const slot = Number(activeIngredientSlot);

    const mealName = `Meal ${slot} - Protein: ${ingredientSelectionDraft.protein}, Veg: ${ingredientSelectionDraft.veg}, Carb: ${ingredientSelectionDraft.carb}`;

    setSelectedMeals((prev) => {
      const withoutSlot = prev.filter(
        (m) => !(m.date === dateKey && Number(m.slotNumber) === slot)
      );

      return [
        ...withoutSlot,
        {
          date: dateKey,
          mealType: 'main',
          menuItemId: fallbackItemId ? String(fallbackItemId) : undefined,
          mealName,
          quantity: 1,
          slotNumber: slot,
          proteinChoice: ingredientSelectionDraft.protein,
          vegChoice: ingredientSelectionDraft.veg,
          carbChoice: ingredientSelectionDraft.carb,
          sauceChoice: ingredientSelectionDraft.sauce
        }
      ];
    });

    setSkippedDateKeys((prev) => prev.filter((key) => key !== dateKey));

    setShowIngredientModal(false);
    setActiveIngredientSlot(null);
    setIngredientSelectionDraft({ protein: '', veg: '', carb: '', sauce: '' });
  };

  const handleOpenCopyModal = () => {
    const sourceDateKey = getDateKey(currentDateGroup?.date);
    const initialTargets = {};
    dateGroups.forEach((group) => {
      const key = getDateKey(group.date);
      if (key && key !== sourceDateKey) {
        initialTargets[key] = false;
      }
    });
    setCopyTargets(initialTargets);
    setCopyError(null);
    setShowCopyDayModal(true);
  };

  const handleApplyCopyToDays = () => {
    const sourceDateKey = getDateKey(currentDateGroup?.date);
    if (!sourceDateKey) return;

    const sourceSelections = selectedMeals.filter((m) => m.date === sourceDateKey);
    if (sourceSelections.length === 0) {
      setCopyError('Please select at least one meal on this day before copying.');
      return;
    }

    const targetDateKeys = Object.keys(copyTargets).filter((key) => copyTargets[key]);
    if (targetDateKeys.length === 0) {
      setCopyError('Please select at least one target day.');
      return;
    }

    const targetSet = new Set(targetDateKeys);
    const withoutTargets = selectedMeals.filter((m) => !targetSet.has(m.date));
    const copiedSelections = targetDateKeys.flatMap((targetDateKey) =>
      sourceSelections.map((meal) => ({
        ...meal,
        date: targetDateKey
      }))
    );
    const projectedSelections = [...withoutTargets, ...copiedSelections];

    setSelectedMeals(projectedSelections);
    setSkippedDateKeys((prev) => prev.filter((key) => !targetSet.has(key)));

    const firstMissingDayIndex = dateGroups.findIndex((group) => {
      const dayKey = getDateKey(group.date);
      return !projectedSelections.some((meal) => meal.date === dayKey);
    });

    if (firstMissingDayIndex >= 0) {
      setMealIndex(firstMissingDayIndex);
    } else if (dateGroups.length > 0) {
      setMealIndex(dateGroups.length - 1);
    }

    setShowCopyDayModal(false);
    setCopyError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Email Entry Step
  if (step === 'email') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-white flex items-center justify-center p-4">
        <div className="bg-white/90 backdrop-blur rounded-2xl shadow-xl border border-white/60 p-8 w-full max-w-md">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center mb-4">
              <img
                src="/images/matter-logo24-dark.png"
                alt="Matter Nutrition"
                className="h-12"
              />
            </div>
            <h1 className="text-3xl font-bold text-gray-900">Weekly Menu Selection</h1>
            <p className="text-gray-600 mt-2">
              {weeklyMenu?.title || 'Select your meals for the week'}
            </p>
          </div>

          <form onSubmit={handleEmailSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 text-gray-400" size={20} />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2">
                <AlertCircle className="text-red-600 flex-shrink-0" size={20} />
                <p className="text-red-700 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader size={20} className="animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  Continue
                  <ChevronRight size={20} />
                </>
              )}
            </button>
          </form>

          {weeklyMenu && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              <p className="text-gray-600 text-sm">
                <strong>Week:</strong> {formatLocalDate(displayRange.start)} -{' '}
                {formatLocalDate(displayRange.end)}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Meals Selection Step
  if (step === 'meals' && weeklyMenu && customerProfile) {
    const isLocked = isDayLocked(currentDateGroup?.date);
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
          <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <img src="/logo.svg" alt="Logo" className="h-9 w-9" />
              <div>
                <h1 className="text-lg font-semibold text-gray-900">Meal Selection</h1>
                <p className="text-xs text-gray-500">Choose your meals for the week</p>
              </div>
            </div>
            <span className="text-xs font-semibold text-gray-700 bg-white/80 border border-gray-200 px-3 py-1 rounded-full">
              {dateGroups.length === 0 ? 0 : mealIndex + 1} / {dateGroups.length}
            </span>
          </div>

          {/* Progress bar */}
          <div className="mb-6">
            <div className="flex gap-1">
              {dateGroups.map((group, idx) => (
                <div
                  key={group.dateKey || idx}
                  className={`h-2 flex-1 rounded-full ${
                    selectedMeals.some((m) => m.date === group.dateKey)
                      ? 'bg-emerald-500'
                      : skippedDateKeys.includes(group.dateKey) || idx < mealIndex
                      ? 'bg-red-500'
                      : idx === mealIndex
                      ? 'bg-indigo-600'
                      : 'bg-gray-300'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Customer Info Card */}
          <div className="bg-white/90 backdrop-blur rounded-2xl shadow-lg border border-white/60 p-6 mb-6">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-xl font-bold text-gray-900">
                  {customerProfile.firstName} {customerProfile.lastName}
                </h3>
                <p className="text-gray-600">{customerProfile.email}</p>
                <div className="mt-4 space-y-2 text-sm">
                  <p>
                    <span className="font-semibold">Meals/Day:</span>{' '}
                    {customerProfile.unlimitedMeals ? 'Unlimited' : customerProfile.mealPerDay}
                  </p>
                  <p>
                    <span className="font-semibold">Plan:</span> {customerProfile.mealPlan}
                  </p>
                  {customerProfile.mealExclusion && (
                    <p>
                      <span className="font-semibold">Exclusions:</span>{' '}
                      {customerProfile.mealExclusion.split(/[\s,]+/).filter(Boolean).join(' • ')}
                    </p>
                  )}
                  {Array.isArray(customerProfile.allergies) && customerProfile.allergies.filter(Boolean).length > 0 && (
                    <p>
                      <span className="font-semibold text-red-700">⛔ Allergens (blocked):</span>{' '}
                      <span className="text-red-700">{customerProfile.allergies.filter(Boolean).join(' • ')}</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Meal Selection Card */}
          <div className="bg-white/95 backdrop-blur rounded-2xl shadow-xl border border-white/60 p-6 relative">
            {(showExclusionModal || showRemainingModal || showBreakfastModal || showCarbVegModal || showKeepOrReplaceModal) && (
              <div className="fixed inset-0 bg-black/70 z-40" />
            )}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2 mb-6">
                <AlertCircle className="text-red-600 flex-shrink-0" size={20} />
                <p className="text-red-700 text-sm">{error}</p>
              </div>
            )}

            {/* Deadline passed — locked banner */}
            {isLocked && (
              <div className="mb-4 flex items-center gap-3 rounded-xl bg-red-50 border border-red-300 px-4 py-3">
                <span className="text-2xl">🔒</span>
                <div>
                  <p className="font-semibold text-red-700">Selection Closed</p>
                  <p className="text-sm text-red-600">
                    The deadline to select meals for{' '}
                    <span className="font-bold">
                      {formatLocalDate(currentDateGroup?.date, { weekday: 'long', month: 'short', day: 'numeric' })}
                    </span>{' '}
                    has passed. Your current selections are shown below (read-only).
                  </p>
                </div>
              </div>
            )}
            <div className="mb-6">
              {dateGroups.length === 0 ? (
                <>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">No eligible meals</h2>
                  <p className="text-gray-600">Please contact support if this looks wrong.</p>
                </>
              ) : (
                <>
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">
                    {formatLocalDate(currentDateGroup?.date, {
                      weekday: 'long',
                      month: 'short',
                      day: 'numeric'
                    })}
                  </h2>
                  <p className="text-indigo-600 font-semibold capitalize text-lg">
                    Meals
                  </p>
                </>
              )}
            </div>

            {/* No Selection Button - At Top */}
            {dateGroups.length > 0 && !isLocked && (
              <div className="mb-6 relative">
                <button
                  onClick={handleNoSelection}
                  className="w-full px-6 py-3 border-2 border-blue-400 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-bold"
                >
                  Skip selection for Today
                </button>

                {/* No Selection Modal - Inline */}
                {showNoSelectionModal && (
                  <div className="mt-3 bg-white rounded-xl shadow-xl border-2 border-orange-300 p-6 animate-fadeIn">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="bg-orange-100 rounded-full p-2">
                        <AlertCircle className="text-orange-600" size={24} />
                      </div>
                      <h3 className="text-xl font-semibold text-gray-900">Selection Reminder</h3>
                    </div>

                    <p className="text-gray-700 mb-6">
                      You haven't made any selections for{' '}
                      <span className="font-semibold">
                        {currentDateGroup?.date ? formatLocalDate(currentDateGroup.date, {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric'
                        }) : 'today'}
                      </span>.
                      <br /><br />
                      Would you like to skip this day and continue?
                    </p>

                    <div className="flex gap-3">
                      <button
                        onClick={() => setShowNoSelectionModal(false)}
                        className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleConfirmNoSelection}
                        className="flex-1 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700"
                      >
                        Skip Day
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {dateGroups.length === 0 ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
                No meals are available for your plan. Breakfast or snack options may be excluded.
              </div>
            ) : (
              <div className={`mb-6 flex gap-6 ${!isBodybuilderFlow ? 'flex-col-reverse' : 'flex-col'}`}>
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-semibold text-gray-900">Meals</h3>
                    {isBodybuilderFlow && dateGroups.length > 1 && (
                      <button
                        type="button"
                        onClick={handleOpenCopyModal}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-100 text-indigo-700 hover:bg-indigo-200 text-sm font-semibold"
                      >
                        <Copy size={14} />
                        Copy To Other Day
                      </button>
                    )}
                  </div>
                  {isBodybuilderFlow ? (
                    <div className="space-y-4">
                      <p className="text-sm text-gray-600">Tap a meal box to select Protein, Vegetables, and Carbs.</p>
                      {/* Unlimited (menu-selection Partner) customers aren't capped at
                          mealPerDay — give the fixed-slot Bodybuilder grid some headroom
                          instead of the usual 1-5 slots. */}
                      {Array.from({ length: customerProfile?.unlimitedMeals ? 12 : (Number(customerProfile?.mealPerDay) || 1) }, (_, idx) => idx + 1).map((slotNumber) => {
                        const selectedSlot = selectedMeals.find(
                          (m) => m.date === getDateKey(currentDateGroup?.date) && Number(m.slotNumber) === slotNumber
                        );

                        return (
                          <button
                            key={slotNumber}
                            type="button"
                            onClick={() => handleIngredientSlotOpen(slotNumber)}
                            className={`w-full text-left p-4 border-2 rounded-lg shadow-sm hover:shadow-md transition ${selectedSlot ? 'border-indigo-600 bg-indigo-50/80' : 'border-gray-200 bg-white'}`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <h4 className="font-bold text-gray-900">Meal {slotNumber}</h4>
                                {selectedSlot ? (
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">
                                      Protein: {selectedSlot.proteinChoice || 'None'}
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded-md border border-lime-200 bg-lime-50 px-2 py-1 text-xs font-semibold text-lime-700">
                                      Veg: {selectedSlot.vegChoice || 'None'}
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
                                      Carb: {selectedSlot.carbChoice || 'None'}
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">
                                      Sauce: {selectedSlot.sauceChoice || 'None'}
                                    </span>
                                  </div>
                                ) : (
                                  <p className="text-sm text-gray-500 mt-1">No ingredients selected yet</p>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`text-xs font-semibold px-2 py-1 rounded-full ${selectedSlot ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>
                                  {selectedSlot ? 'Selected' : 'Select'}
                                </span>
                                <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full bg-white border border-gray-300 text-gray-700">
                                  <Pencil size={12} />
                                  Edit
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                  <div className="space-y-4">
                    {currentMainMeals.length === 0 ? (
                      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                        No main meals available for this day.
                      </div>
                    ) : (
                      currentMainMeals.map((mealEntry) => (
                        <div key={`${mealEntry.mealType}-${mealEntry.date}`} className="space-y-3">
                          {mealEntry.items?.map((item) => {
                            const itemIdStr = String(item._id);
                            const isAllergenBlocked = allergenBlockedIds.has(itemIdStr);
                            const match = selectedMeals.find(m => {
                              const mIdStr = String(m.menuItemId || '');
                              return mIdStr === itemIdStr && m.date === getDateKey(mealEntry?.date);
                            });
                            const qty = match?.quantity || 0;
                            return (
                              <div
                                key={item._id}
                                role="button"
                                tabIndex={isLocked ? -1 : 0}
                                onClick={(e) => {
                                  if (isAllergenBlocked) {
                                    setAllergenBlockData(prev => prev?.id === itemIdStr ? null : { id: itemIdStr, mealName: item.mealName, date: mealEntry?.date, matched: allergenBlockedIds.get(itemIdStr) || [] });
                                    return;
                                  }
                                  if (!isLocked) handleMealSelect(item._id, mealEntry);
                                }}
                                onKeyDown={(e) => {
                                  if (isLocked || isAllergenBlocked) return;
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    handleMealSelect(item._id, mealEntry);
                                  }
                                }}
                                className={`w-full p-4 border rounded-xl transition text-left relative ${allergenBlockData?.id === itemIdStr ? 'z-40 ' : ''}${
                                  isAllergenBlocked
                                    ? 'border-red-300 bg-red-50 cursor-pointer'
                                    : isLocked
                                    ? 'border-gray-200 bg-gray-50 cursor-not-allowed opacity-60'
                                    : qty > 0
                                      ? 'border-gray-300 bg-white shadow-sm cursor-pointer'
                                      : 'border-gray-200 bg-white hover:shadow-sm cursor-pointer'
                                }`}
                              >
                                {isAllergenBlocked && (
                                  <div className="flex items-center gap-1.5 mb-2">
                                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700 border border-red-200">
                                      <AlertCircle size={11} />
                                      Contains allergen — tap for help
                                    </span>
                                  </div>
                                )}
                                <h4 className={`font-black text-base uppercase tracking-wide mb-3 break-words leading-snug ${isAllergenBlocked ? 'text-red-800' : 'text-gray-900'}`}>{item.mealName}</h4>
                                {item.proteinSource && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Portion:</span> {item.proteinSource}
                                    {visibleIngredientNames(item.portionIngredients) && ` — ${visibleIngredientNames(item.portionIngredients)}`}
                                  </p>
                                )}
                                {item.carbs && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Carb:</span> {item.carbs}
                                    {visibleIngredientNames(item.carbIngredients) && ` — ${visibleIngredientNames(item.carbIngredients)}`}
                                  </p>
                                )}
                                {item.veg && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Vegetables:</span> {item.veg}
                                    {visibleIngredientNames(item.vegIngredients) && ` — ${visibleIngredientNames(item.vegIngredients)}`}
                                  </p>
                                )}
                                {item.sauce && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Sauce:</span> {item.sauce}
                                    {visibleIngredientNames(item.sauceIngredients) && ` — ${visibleIngredientNames(item.sauceIngredients)}`}
                                  </p>
                                )}
                                {item.intolerances && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Allergens:</span> {item.intolerances}
                                  </p>
                                )}
                                <div className="mt-4 flex items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={isLocked || isAllergenBlocked}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!isAllergenBlocked) handleMealDecrement(item._id, mealEntry);
                                    }}
                                    className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white text-gray-900 text-lg leading-none hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    -
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isLocked || isAllergenBlocked}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!isAllergenBlocked) handleMealSelect(item._id, mealEntry);
                                    }}
                                    className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white text-gray-900 text-lg leading-none hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    +
                                  </button>
                                  {qty > 0 && (
                                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded-full px-2 py-1 ml-1">
                                      {qty} selected
                                      <Check className="text-indigo-600" size={14} />
                                    </span>
                                  )}
                                </div>

                                {showExclusionModal && pendingSelection?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-rose-200 bg-rose-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-base">
                                      <AlertCircle size={16} className="text-rose-600" />
                                      <span className="text-rose-700 font-bold">Exclusion Alert</span>
                                    </div>
                                    <p className="text-gray-800 text-base font-semibold">
                                      This meal's portion includes items in your exclusions. Would you like to keep it?
                                    </p>
                                    <div className="bg-white border border-rose-200 rounded-lg px-3 py-2">
                                      <span className="font-semibold text-rose-700">Matched exclusions:</span>
                                      <div className="mt-1 break-words">
                                        {pendingSelection.exclusions?.join(', ') || 'None'}
                                      </div>
                                    </div>
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowExclusionModal(false);
                                          setPendingSelection(null);
                                          setAcknowledgeExclusion(false);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-100 font-semibold"
                                      >
                                        Go Back
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!acknowledgeExclusion) return;
                                          proceedWithSelection(pendingSelection);
                                          setShowExclusionModal(false);
                                          setPendingSelection(null);
                                          setAcknowledgeExclusion(false);
                                        }}
                                        className={`flex-1 px-3 py-2 rounded-lg text-white font-semibold ${
                                          acknowledgeExclusion
                                            ? 'bg-indigo-600 hover:bg-indigo-700'
                                            : 'bg-indigo-300 cursor-not-allowed'
                                        }`}
                                      >
                                        Select Anyway
                                      </button>
                                    </div>
                                    <label className="flex items-start gap-2 text-gray-800 font-semibold">
                                      <input
                                        type="checkbox"
                                        checked={acknowledgeExclusion}
                                        onChange={(e) => setAcknowledgeExclusion(e.target.checked)}
                                        className="mt-1 h-4 w-4"
                                      />
                                      <span className="text-sm font-semibold">
                                        You are aware that you selected something that is in your exclusions.
                                      </span>
                                    </label>
                                  </div>
                                )}

                                {showCarbVegModal && pendingCarbVegPayload?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-rose-200 bg-rose-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-base">
                                      <AlertCircle size={16} className="text-rose-600" />
                                      <span className="text-rose-700 font-bold">Exclusion Alert</span>
                                    </div>
                                    <p className="text-gray-800 text-base font-semibold">
                                      This meal includes items in your exclusions.
                                    </p>
                                    {pendingCarbVegPayload.matchedCarbItems?.length > 0 && (
                                      <div className="bg-white border border-rose-200 rounded-lg px-3 py-2">
                                        <span className="font-semibold text-rose-700">Carb:</span>
                                        <div className="mt-1 break-words">{pendingCarbVegPayload.matchedCarbItems.join(', ')}</div>
                                      </div>
                                    )}
                                    {pendingCarbVegPayload.matchedVegItems?.length > 0 && (
                                      <div className="bg-white border border-rose-200 rounded-lg px-3 py-2">
                                        <span className="font-semibold text-rose-700">Veg:</span>
                                        <div className="mt-1 break-words">{pendingCarbVegPayload.matchedVegItems.join(', ')}</div>
                                      </div>
                                    )}
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowCarbVegModal(false);
                                          setPendingCarbVegPayload(null);
                                          setAcknowledgeExclusion(false);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-100 font-semibold"
                                      >
                                        Go Back
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!acknowledgeExclusion) return;
                                          setShowCarbVegModal(false);
                                          setShowKeepOrReplaceModal(true);
                                          setAcknowledgeExclusion(false);
                                        }}
                                        className={`flex-1 px-3 py-2 rounded-lg text-white font-semibold ${acknowledgeExclusion ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-indigo-300 cursor-not-allowed'}`}
                                      >
                                        Select Anyway
                                      </button>
                                    </div>
                                    <label className="flex items-start gap-2 text-gray-800 font-semibold">
                                      <input
                                        type="checkbox"
                                        checked={acknowledgeExclusion}
                                        onChange={(e) => setAcknowledgeExclusion(e.target.checked)}
                                        className="mt-1 h-4 w-4"
                                      />
                                      <span className="text-sm font-semibold">
                                        You are aware that you selected something that is in your exclusions.
                                      </span>
                                    </label>
                                  </div>
                                )}

                                {showKeepOrReplaceModal && pendingCarbVegPayload?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-amber-200 bg-amber-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-base">
                                      <AlertCircle size={16} className="text-amber-600" />
                                      <span className="text-amber-700 font-bold">Keep or Replace?</span>
                                    </div>
                                    <p className="text-gray-800 text-base font-semibold">
                                      Would you like to keep the {[...(pendingCarbVegPayload.matchedCarbItems || []), ...(pendingCarbVegPayload.matchedVegItems || [])].join(', ')} or have them replaced?
                                    </p>
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          proceedWithSelection(pendingCarbVegPayload, 'kept');
                                          setShowKeepOrReplaceModal(false);
                                          setPendingCarbVegPayload(null);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-amber-300 bg-white text-gray-900 hover:bg-amber-50 font-semibold"
                                      >
                                        Keep It
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          proceedWithSelection(pendingCarbVegPayload, 'replace');
                                          setShowKeepOrReplaceModal(false);
                                          setPendingCarbVegPayload(null);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold"
                                      >
                                        Replace It
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {showBreakfastModal && pendingBreakfastSelection?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-amber-200 bg-amber-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-lg">
                                      <AlertCircle size={16} className="text-amber-600" />
                                      <span className="text-amber-700 font-bold">Disclaimer</span>
                                    </div>
                                    <p className="text-gray-800 text-lg font-semibold">
                                      A breakfast meal is not included in your default meal split!
                                    </p>
                                    <p className="text-gray-700 text-base">
                                      If you choose to add a breakfast option, we may not be able to match your plan’s macro targets. Please note that all breakfast meals are pre-set, and macro variations may occur.
                                    </p>
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowBreakfastModal(false);
                                          setPendingBreakfastSelection(null);
                                          setAcknowledgeBreakfast(false);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-100 font-semibold"
                                      >
                                        Go Back
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!acknowledgeBreakfast) return;
                                          handleBreakfastConfirm(pendingBreakfastSelection);
                                        }}
                                        className={`flex-1 px-3 py-2 rounded-lg text-white font-semibold ${
                                          acknowledgeBreakfast
                                            ? 'bg-indigo-600 hover:bg-indigo-700'
                                            : 'bg-indigo-300 cursor-not-allowed'
                                        }`}
                                      >
                                        Select Anyway
                                      </button>
                                    </div>
                                    <label className="flex items-start gap-2 text-gray-800 font-semibold">
                                      <input
                                        type="checkbox"
                                        checked={acknowledgeBreakfast}
                                        onChange={(e) => setAcknowledgeBreakfast(e.target.checked)}
                                        className="mt-1 h-4 w-4"
                                      />
                                      <span className="text-sm font-semibold">
                                        I understand the breakfast option may impact my macro targets.
                                      </span>
                                    </label>
                                  </div>
                                )}

                                {inlineLimitError?.mealItemId === item._id && (
                                  <div className="absolute inset-0 rounded-2xl border border-amber-200 bg-amber-50/95 p-4 text-sm font-semibold text-gray-800 shadow-xl z-40 flex flex-col justify-between">
                                    <div className="flex items-center justify-between mb-4">
                                      <div className="flex items-center gap-2">
                                        <AlertCircle size={16} className="text-amber-600" />
                                        <span className="text-amber-700">Selection Limit</span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setInlineLimitError(null);
                                        }}
                                        className="p-1 hover:bg-amber-200 rounded-lg transition"
                                        aria-label="Close"
                                      >
                                        <X size={20} className="text-amber-700" />
                                      </button>
                                    </div>
                                    <p className="text-gray-800 mb-4 text-sm">{inlineLimitError.message}</p>
                                  </div>
                                )}

                                {allergenBlockData?.id === itemIdStr && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border-2 border-red-300 bg-white p-5 shadow-2xl z-50 flex flex-col gap-3" onClick={e => e.stopPropagation()}>
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        <AlertCircle size={16} className="text-red-600" />
                                        <span className="text-red-700 font-bold">Allergen Block</span>
                                      </div>
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setAllergenBlockData(null); }} className="p-1 hover:bg-red-100 rounded-lg"><X size={18} className="text-red-600" /></button>
                                    </div>
                                    <p className="text-sm font-semibold text-gray-800">
                                      "{item.mealName}" cannot be selected because it contains an allergen that matches your profile.
                                    </p>
                                    <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                      <span className="font-semibold text-red-700 text-xs">Matched allergen(s):</span>
                                      <div className="mt-1 text-gray-800 text-xs">{(allergenBlockedIds.get(itemIdStr) || []).join(', ')}</div>
                                    </div>
                                    <p className="text-sm text-gray-600">Please contact our customer service team to discuss alternative options.</p>
                                    <a
                                      href={`https://wa.me/971528913398?text=${encodeURIComponent(`I understand that ${item.mealName} on ${mealEntry?.date ? (() => { const [y,mo,d] = String(mealEntry.date).split('T')[0].split('-').map(Number); return new Date(y, mo-1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); })() : ''} contains ingredients I'm allergic to, and I acknowledge the associated risk. By proceeding with this selection, I accept full responsibility for my choice.`)}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="w-full flex items-center justify-center gap-2 bg-green-500 hover:bg-green-600 text-white font-bold py-2.5 px-4 rounded-xl text-sm"
                                    >
                                      Contact Customer Service on WhatsApp
                                    </a>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                  )}
                </div>

                {!isBodybuilderFlow && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-semibold text-gray-900">Breakfast</h3>
                  </div>
                  <div className="space-y-4">
                    {currentBreakfastMeals.length === 0 ? (
                      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                        No breakfast options available for this day.
                      </div>
                    ) : (
                      currentBreakfastMeals.map((mealEntry) => (
                        <div key={`${mealEntry.mealType}-${mealEntry.date}`} className="space-y-3">
                          {mealEntry.items?.map((item) => {
                            const itemIdStr = String(item._id);
                            const isAllergenBlocked = allergenBlockedIds.has(itemIdStr);
                            const match = selectedMeals.find(m => {
                              const mIdStr = String(m.menuItemId || '');
                              return mIdStr === itemIdStr && m.date === getDateKey(mealEntry?.date);
                            });
                            const qty = match?.quantity || 0;
                            return (
                              <div
                                key={item._id}
                                role="button"
                                tabIndex={isLocked ? -1 : 0}
                                onClick={(e) => {
                                  if (isAllergenBlocked) {
                                    setAllergenBlockData(prev => prev?.id === itemIdStr ? null : { id: itemIdStr, mealName: item.mealName, date: mealEntry?.date, matched: allergenBlockedIds.get(itemIdStr) || [] });
                                    return;
                                  }
                                  if (!isLocked) handleMealSelect(item._id, mealEntry);
                                }}
                                onKeyDown={(e) => {
                                  if (isLocked || isAllergenBlocked) return;
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    handleMealSelect(item._id, mealEntry);
                                  }
                                }}
                                className={`w-full p-4 border rounded-xl transition text-left relative ${allergenBlockData?.id === itemIdStr ? 'z-40 ' : ''}${
                                  isAllergenBlocked
                                    ? 'border-red-300 bg-red-50 cursor-pointer'
                                    : isLocked
                                    ? 'border-gray-200 bg-gray-50 cursor-not-allowed opacity-60'
                                    : qty > 0
                                      ? 'border-gray-300 bg-white shadow-sm cursor-pointer'
                                      : 'border-gray-200 bg-white hover:shadow-sm cursor-pointer'
                                }`}
                              >
                                {isAllergenBlocked && (
                                  <div className="flex items-center gap-1.5 mb-2">
                                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700 border border-red-200">
                                      <AlertCircle size={11} />
                                      Contains allergen — tap for help
                                    </span>
                                  </div>
                                )}
                                <h4 className={`font-black text-base uppercase tracking-wide mb-3 break-words leading-snug ${isAllergenBlocked ? 'text-red-800' : 'text-gray-900'}`}>{item.mealName}</h4>
                                {item.proteinSource && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Portion:</span> {item.proteinSource}
                                    {visibleIngredientNames(item.portionIngredients) && ` — ${visibleIngredientNames(item.portionIngredients)}`}
                                  </p>
                                )}
                                {item.carbs && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Carb:</span> {item.carbs}
                                    {visibleIngredientNames(item.carbIngredients) && ` — ${visibleIngredientNames(item.carbIngredients)}`}
                                  </p>
                                )}
                                {item.veg && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Vegetables:</span> {item.veg}
                                    {visibleIngredientNames(item.vegIngredients) && ` — ${visibleIngredientNames(item.vegIngredients)}`}
                                  </p>
                                )}
                                {item.sauce && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Sauce:</span> {item.sauce}
                                    {visibleIngredientNames(item.sauceIngredients) && ` — ${visibleIngredientNames(item.sauceIngredients)}`}
                                  </p>
                                )}
                                {item.intolerances && (
                                  <p className="text-sm text-gray-700 mb-1 break-words lowercase">
                                    <span className="font-bold text-gray-500">Allergens:</span> {item.intolerances}
                                  </p>
                                )}
                                <div className="mt-4 flex items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={isLocked || isAllergenBlocked}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!isAllergenBlocked) handleMealDecrement(item._id, mealEntry);
                                    }}
                                    className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white text-gray-900 text-lg leading-none hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    -
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isLocked || isAllergenBlocked}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!isAllergenBlocked) handleMealSelect(item._id, mealEntry);
                                    }}
                                    className="w-8 h-8 flex items-center justify-center rounded border border-gray-300 bg-white text-gray-900 text-lg leading-none hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    +
                                  </button>
                                  {qty > 0 && (
                                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded-full px-2 py-1 ml-1">
                                      {qty} selected
                                      <Check className="text-indigo-600" size={14} />
                                    </span>
                                  )}
                                </div>

                                {showExclusionModal && pendingSelection?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-rose-200 bg-rose-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-base">
                                      <AlertCircle size={16} className="text-rose-600" />
                                      <span className="text-rose-700 font-bold">Exclusion Alert</span>
                                    </div>
                                    <p className="text-gray-800 text-base font-semibold">
                                      This meal's portion includes items in your exclusions. Would you like to keep it?
                                    </p>
                                    <div className="bg-white border border-rose-200 rounded-lg px-3 py-2">
                                      <span className="font-semibold text-rose-700">Matched exclusions:</span>
                                      <div className="mt-1 break-words">
                                        {pendingSelection.exclusions?.join(', ') || 'None'}
                                      </div>
                                    </div>
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowExclusionModal(false);
                                          setPendingSelection(null);
                                          setAcknowledgeExclusion(false);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-100 font-semibold"
                                      >
                                        Go Back
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e)=>{e.stopPropagation();if(!acknowledgeExclusion) return;proceedWithSelection(pendingSelection);setShowExclusionModal(false);setPendingSelection(null);setAcknowledgeExclusion(false);}}
                                        className={`flex-1 px-3 py-2 rounded-lg text-white font-semibold ${
                                          acknowledgeExclusion
                                            ? 'bg-indigo-600 hover:bg-indigo-700'
                                            : 'bg-indigo-300 cursor-not-allowed'
                                        }`}
                                      >
                                        Select Anyway
                                      </button>
                                    </div>
                                    <label className="flex items-start gap-2 text-gray-800 font-semibold">
                                      <input
                                        type="checkbox"
                                        checked={acknowledgeExclusion}
                                        onChange={(e) => setAcknowledgeExclusion(e.target.checked)}
                                        className="mt-1 h-4 w-4"
                                      />
                                      <span className="text-sm font-semibold">
                                        You are aware that you selected something that is in your exclusions.
                                      </span>
                                    </label>
                                  </div>
                                )}

                                {showCarbVegModal && pendingCarbVegPayload?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-rose-200 bg-rose-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-base">
                                      <AlertCircle size={16} className="text-rose-600" />
                                      <span className="text-rose-700 font-bold">Exclusion Alert</span>
                                    </div>
                                    <p className="text-gray-800 text-base font-semibold">
                                      This meal includes items in your exclusions.
                                    </p>
                                    {pendingCarbVegPayload.matchedCarbItems?.length > 0 && (
                                      <div className="bg-white border border-rose-200 rounded-lg px-3 py-2">
                                        <span className="font-semibold text-rose-700">Carb:</span>
                                        <div className="mt-1 break-words">{pendingCarbVegPayload.matchedCarbItems.join(', ')}</div>
                                      </div>
                                    )}
                                    {pendingCarbVegPayload.matchedVegItems?.length > 0 && (
                                      <div className="bg-white border border-rose-200 rounded-lg px-3 py-2">
                                        <span className="font-semibold text-rose-700">Veg:</span>
                                        <div className="mt-1 break-words">{pendingCarbVegPayload.matchedVegItems.join(', ')}</div>
                                      </div>
                                    )}
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowCarbVegModal(false);
                                          setPendingCarbVegPayload(null);
                                          setAcknowledgeExclusion(false);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-100 font-semibold"
                                      >
                                        Go Back
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!acknowledgeExclusion) return;
                                          setShowCarbVegModal(false);
                                          setShowKeepOrReplaceModal(true);
                                          setAcknowledgeExclusion(false);
                                        }}
                                        className={`flex-1 px-3 py-2 rounded-lg text-white font-semibold ${acknowledgeExclusion ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-indigo-300 cursor-not-allowed'}`}
                                      >
                                        Select Anyway
                                      </button>
                                    </div>
                                    <label className="flex items-start gap-2 text-gray-800 font-semibold">
                                      <input
                                        type="checkbox"
                                        checked={acknowledgeExclusion}
                                        onChange={(e) => setAcknowledgeExclusion(e.target.checked)}
                                        className="mt-1 h-4 w-4"
                                      />
                                      <span className="text-sm font-semibold">
                                        You are aware that you selected something that is in your exclusions.
                                      </span>
                                    </label>
                                  </div>
                                )}

                                {showKeepOrReplaceModal && pendingCarbVegPayload?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-amber-200 bg-amber-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-base">
                                      <AlertCircle size={16} className="text-amber-600" />
                                      <span className="text-amber-700 font-bold">Keep or Replace?</span>
                                    </div>
                                    <p className="text-gray-800 text-base font-semibold">
                                      Would you like to keep the {[...(pendingCarbVegPayload.matchedCarbItems || []), ...(pendingCarbVegPayload.matchedVegItems || [])].join(', ')} or have them replaced?
                                    </p>
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          proceedWithSelection(pendingCarbVegPayload, 'kept');
                                          setShowKeepOrReplaceModal(false);
                                          setPendingCarbVegPayload(null);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-amber-300 bg-white text-gray-900 hover:bg-amber-50 font-semibold"
                                      >
                                        Keep It
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          proceedWithSelection(pendingCarbVegPayload, 'replace');
                                          setShowKeepOrReplaceModal(false);
                                          setPendingCarbVegPayload(null);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold"
                                      >
                                        Replace It
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {showBreakfastModal && pendingBreakfastSelection?.mealItemId === item._id && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border border-amber-200 bg-amber-50/95 p-5 text-sm text-gray-800 shadow-xl z-50 flex flex-col gap-3 pb-6">
                                    <div className="flex items-center gap-2 text-lg">
                                      <AlertCircle size={16} className="text-amber-600" />
                                      <span className="text-amber-700 font-bold">Disclaimer</span>
                                    </div>
                                    <p className="text-gray-800 text-lg font-semibold">
                                      A breakfast meal is not included in your default meal split!
                                    </p>
                                    <p className="text-gray-700 text-base">
                                      If you choose to add a breakfast option, we may not be able to match your plan’s macro targets. Please note that all breakfast meals are pre-set, and macro variations may occur.
                                    </p>
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowBreakfastModal(false);
                                          setPendingBreakfastSelection(null);
                                          setAcknowledgeBreakfast(false);
                                        }}
                                        className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-100 font-semibold"
                                      >
                                        Go Back
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!acknowledgeBreakfast) return;
                                          handleBreakfastConfirm(pendingBreakfastSelection);
                                        }}
                                        className={`flex-1 px-3 py-2 rounded-lg text-white font-semibold ${
                                          acknowledgeBreakfast
                                            ? 'bg-indigo-600 hover:bg-indigo-700'
                                            : 'bg-indigo-300 cursor-not-allowed'
                                        }`}
                                      >
                                        Select Anyway
                                      </button>
                                    </div>
                                    <label className="flex items-start gap-2 text-gray-800 font-semibold">
                                      <input
                                        type="checkbox"
                                        checked={acknowledgeBreakfast}
                                        onChange={(e) => setAcknowledgeBreakfast(e.target.checked)}
                                        className="mt-1 h-4 w-4"
                                      />
                                      <span className="text-sm font-semibold">
                                        I understand the breakfast option may impact my macro targets.
                                      </span>
                                    </label>
                                  </div>
                                )}

                                {inlineLimitError?.mealItemId === item._id && (
                                  <div className="absolute inset-0 rounded-2xl border border-amber-200 bg-amber-50/95 p-4 text-sm font-semibold text-gray-800 shadow-xl z-40 flex flex-col justify-between">
                                    <div className="flex items-center justify-between mb-4">
                                      <div className="flex items-center gap-2">
                                        <AlertCircle size={16} className="text-amber-600" />
                                        <span className="text-amber-700">Selection Limit</span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setInlineLimitError(null);
                                        }}
                                        className="p-1 hover:bg-amber-200 rounded-lg transition"
                                        aria-label="Close"
                                      >
                                        <X size={20} className="text-amber-700" />
                                      </button>
                                    </div>
                                    <p className="text-gray-800 mb-4 text-sm">{inlineLimitError.message}</p>
                                  </div>
                                )}

                                {allergenBlockData?.id === itemIdStr && (
                                  <div className="absolute left-0 right-0 top-0 rounded-2xl border-2 border-red-300 bg-white p-5 shadow-2xl z-50 flex flex-col gap-3" onClick={e => e.stopPropagation()}>
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        <AlertCircle size={16} className="text-red-600" />
                                        <span className="text-red-700 font-bold">Allergen Block</span>
                                      </div>
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setAllergenBlockData(null); }} className="p-1 hover:bg-red-100 rounded-lg"><X size={18} className="text-red-600" /></button>
                                    </div>
                                    <p className="text-sm font-semibold text-gray-800">
                                      "{item.mealName}" cannot be selected because it contains an allergen that matches your profile.
                                    </p>
                                    <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                      <span className="font-semibold text-red-700 text-xs">Matched allergen(s):</span>
                                      <div className="mt-1 text-gray-800 text-xs">{(allergenBlockedIds.get(itemIdStr) || []).join(', ')}</div>
                                    </div>
                                    <p className="text-sm text-gray-600">Please contact our customer service team to discuss alternative options.</p>
                                    <a
                                      href={`https://wa.me/971528913398?text=${encodeURIComponent(`I understand that ${item.mealName} on ${mealEntry?.date ? (() => { const [y,mo,d] = String(mealEntry.date).split('T')[0].split('-').map(Number); return new Date(y, mo-1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); })() : ''} contains ingredients I'm allergic to, and I acknowledge the associated risk. By proceeding with this selection, I accept full responsibility for my choice.`)}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="w-full flex items-center justify-center gap-2 bg-green-500 hover:bg-green-600 text-white font-bold py-2.5 px-4 rounded-xl text-sm"
                                    >
                                      Contact Customer Service on WhatsApp
                                    </a>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                </div>
                )}
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2 mb-6">
                <AlertCircle className="text-red-600 flex-shrink-0" size={20} />
                <p className="text-red-700 text-sm">{error}</p>
              </div>
            )}


            {showRemainingModal && (
              <div className="absolute left-4 right-4 bottom-4 z-50 rounded-2xl border border-indigo-200 bg-indigo-50/95 p-4 text-sm text-gray-800 shadow-xl">
                <div className="flex items-center gap-2 mb-2 text-base">
                  <AlertCircle size={16} className="text-indigo-600" />
                  <span className="font-bold text-indigo-700">Selection Reminder</span>
                </div>
                <p className="text-gray-800 mb-3 text-base">
                  <>You still have <span className="font-semibold text-gray-900">{remainingCount}</span> meal{remainingCount === 1 ? '' : 's'} remaining for this day. Would you like to select again or continue?</>
                </p>
                <label className="flex items-start gap-2 text-gray-800 font-semibold mb-3">
                  <input
                    type="checkbox"
                    checked={acknowledgeRemaining}
                    onChange={(e) => setAcknowledgeRemaining(e.target.checked)}
                    className="mt-1 h-4 w-4"
                  />
                  <span className="text-sm font-semibold">
                    I understand I am continuing without using all remaining meals.
                  </span>
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowRemainingModal(false);
                      setPendingNavAction(null);
                      setAcknowledgeRemaining(false);
                    }}
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 hover:bg-gray-100 font-semibold"
                  >
                    Go Back
                  </button>
                  <button
                    onClick={handleContinueAnyway}
                    disabled={!acknowledgeRemaining}
                    className={`flex-1 px-3 py-2 rounded-lg text-white font-semibold ${
                      acknowledgeRemaining
                        ? 'bg-indigo-600 hover:bg-indigo-700'
                        : 'bg-indigo-300 cursor-not-allowed'
                    }`}
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}



            {showIngredientModal && isBodybuilderFlow && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-black/60" onClick={() => setShowIngredientModal(false)} />
                <div className="relative w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl">
                  <h3 className="text-xl font-bold text-gray-900 mb-1">Meal {activeIngredientSlot}</h3>
                  <p className="text-sm text-gray-600 mb-4">Select ingredients separately and confirm.</p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1">Protein</label>
                      <select
                        value={ingredientSelectionDraft.protein}
                        onChange={(e) => setIngredientSelectionDraft((prev) => ({ ...prev, protein: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="">Select protein</option>
                        {currentIngredientOptions.protein.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1">Vegetables</label>
                      <select
                        value={ingredientSelectionDraft.veg}
                        onChange={(e) => setIngredientSelectionDraft((prev) => ({ ...prev, veg: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="">Select vegetables</option>
                        {currentIngredientOptions.veg.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1">Carbs</label>
                      <select
                        value={ingredientSelectionDraft.carb}
                        onChange={(e) => setIngredientSelectionDraft((prev) => ({ ...prev, carb: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="">Select carbs</option>
                        {currentIngredientOptions.carb.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1">Sauce (optional)</label>
                      <select
                        value={ingredientSelectionDraft.sauce}
                        onChange={(e) => setIngredientSelectionDraft((prev) => ({ ...prev, sauce: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="">Select sauce</option>
                        {currentIngredientOptions.sauce.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-5 flex gap-3">
                    <button
                      type="button"
                      onClick={() => setShowIngredientModal(false)}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleIngredientSlotConfirm}
                      disabled={!ingredientSelectionDraft.protein || !ingredientSelectionDraft.veg || !ingredientSelectionDraft.carb}
                      className="flex-1 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
                    >
                      Confirm Meal
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showCopyDayModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div
                  className="absolute inset-0 bg-black/60"
                  onClick={() => {
                    setShowCopyDayModal(false);
                    setCopyError(null);
                  }}
                />
                <div className="relative w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl">
                  <h3 className="text-xl font-bold text-gray-900 mb-1">Copy Selection To Other Day</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Select days that should receive the same selection as{' '}
                    {formatLocalDate(currentDateGroup?.date, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric'
                    })}.
                  </p>

                  <div className="max-h-64 overflow-y-auto space-y-2 border border-gray-200 rounded-lg p-3">
                    {dateGroups
                      .filter((group) => getDateKey(group.date) !== getDateKey(currentDateGroup?.date))
                      .map((group) => {
                        const key = getDateKey(group.date);
                        return (
                          <label key={key} className="flex items-center gap-3 p-2 rounded hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(copyTargets[key])}
                              onChange={(e) =>
                                setCopyTargets((prev) => ({
                                  ...prev,
                                  [key]: e.target.checked
                                }))
                              }
                              className="h-4 w-4"
                            />
                            <span className="text-sm font-medium text-gray-800">
                              {formatLocalDate(group.date, {
                                weekday: 'long',
                                month: 'short',
                                day: 'numeric'
                              })}
                            </span>
                          </label>
                        );
                      })}
                  </div>

                  {copyError && (
                    <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-2 text-sm text-red-700">
                      {copyError}
                    </div>
                  )}

                  <div className="mt-5 flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setShowCopyDayModal(false);
                        setCopyError(null);
                      }}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleApplyCopyToDays}
                      className="flex-1 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                    >
                      Copy Selection
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Navigation */}
            <div className="flex justify-between gap-4">
              <button
                onClick={handlePrevious}
                disabled={mealIndex === 0}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                <ChevronLeft size={20} />
                Previous
              </button>

              {mealIndex === dateGroups.length - 1 ? (
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button
                    onClick={handleSubmit}
                    disabled={loading || dateGroups.length === 0}
                    className="w-full sm:flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <>
                        <Loader size={20} className="animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      <>
                        <Check size={20} />
                        Complete Selection
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleNext}
                  disabled={dateGroups.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  Next
                  <ChevronRight size={20} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Completion Step
  if (step === 'complete') {
    // Group selected meals by date for display
    const mealsByDate = selectedMeals.reduce((acc, meal) => {
      const dateKey = meal.date || '';
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(meal);
      return acc;
    }, {});

    const sortedDates = Object.keys(mealsByDate).sort();
    const allDateKeys = (() => {
      const start = parseLocalDate(weeklyMenu?.startDate);
      const end = parseLocalDate(weeklyMenu?.endDate);

      if (!start || !end || start > end) {
        return sortedDates;
      }

      const keys = [];
      const current = new Date(start);
      while (current <= end) {
        keys.push(getDateKey(current));
        current.setDate(current.getDate() + 1);
      }

      return keys;
    })();

    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 via-emerald-50 to-white flex items-center justify-center p-4">
        <div className="bg-white/90 backdrop-blur rounded-2xl shadow-xl border border-white/60 p-8 w-full max-w-2xl">
          <div className="flex justify-center mb-4">
            <div className="bg-white border border-gray-200 rounded-full p-3">
              <img src="/logo.svg" alt="Logo" className="h-10 w-10" />
            </div>
          </div>
          <div className="flex justify-center mb-4">
            <div className="bg-green-100 rounded-full p-4">
              <Check className="text-green-600" size={48} />
            </div>
          </div>

          <h1 className="text-3xl font-bold text-gray-900 mb-2 text-center">All Set!</h1>
          <p className="text-gray-600 mb-6 text-center">
            {(() => {
              const showCustom = weeklyMenu?.enableCompletionMessage && weeklyMenu?.completionMessage;
              console.log('Completion page render - showCustom:', showCustom);
              console.log('weeklyMenu?.enableCompletionMessage:', weeklyMenu?.enableCompletionMessage);
              console.log('weeklyMenu?.completionMessage:', weeklyMenu?.completionMessage);
              return showCustom
                ? weeklyMenu.completionMessage
                : 'Your meal selections have been saved successfully.';
            })()}
          </p>

          {/* Customer Profile Summary */}
          <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-lg p-4 mb-6">
            <div className="text-center mb-3">
              <h2 className="text-lg font-bold text-gray-900">
                {customerProfile.firstName} {customerProfile.lastName}
              </h2>
              <p className="text-sm text-gray-600">{customerProfile.email}</p>
            </div>
            <div className="space-y-2 text-sm text-gray-700">
              <p className="text-center">
                <span className="font-semibold">Meals/Day:</span> {customerProfile.unlimitedMeals ? 'Unlimited' : customerProfile.mealPerDay}
              </p>
              <p className="text-center">
                <span className="font-semibold">Plan:</span> {customerProfile.mealPlan}
              </p>
              {customerProfile.mealExclusion && (
                <p className="text-center">
                  <span className="font-semibold">Exclusions:</span>{' '}
                  {customerProfile.mealExclusion.split(/[\s,]+/).filter(Boolean).join(' • ')}
                </p>
              )}
              {Array.isArray(customerProfile.allergies) && customerProfile.allergies.filter(Boolean).length > 0 && (
                <p className="text-center">
                  <span className="font-semibold text-red-700">⛔ Allergens (blocked):</span>{' '}
                  <span className="text-red-700">{customerProfile.allergies.filter(Boolean).join(' • ')}</span>
                </p>
              )}
            </div>
          </div>

          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
            <p className="text-green-700 text-sm text-center">
              <strong>{selectedMeals.reduce((sum, m) => sum + (m.quantity || 1), 0)}</strong> meals selected for the week
            </p>
          </div>


          {/* Selection Summary */}
          <div className="mb-6 max-h-96 overflow-y-auto">
            <div className="space-y-6">
              {allDateKeys.map((dateKey) => {
                const meals = mealsByDate[dateKey] || [];
                return (
                  <div key={dateKey} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                        <span className="text-indigo-600">📅</span>
                        {formatLocalDate(dateKey, {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </h3>
                      <span className="text-sm text-indigo-600 bg-indigo-50 px-2 py-1 rounded-full font-medium">
                        {meals.reduce((sum, m) => sum + (m.quantity || 1), 0)} meals
                      </span>
                    </div>
                    {meals.length === 0 ? (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                        <div className="text-sm font-medium text-red-700">No meal selection</div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {meals.map((meal, idx) => (
                          <div key={idx} className="bg-gradient-to-r from-green-50 to-emerald-50 border-l-4 border-green-500 rounded-lg p-4 flex items-start gap-3">
                            <div className="bg-white rounded-lg p-2 flex-shrink-0">
                              <UtensilsCrossed className="w-6 h-6 text-green-600" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="font-bold text-gray-900 text-sm uppercase tracking-wide">
                                {meal.mealName}
                              </h4>
                              {(meal.proteinChoice || meal.vegChoice || meal.carbChoice || meal.sauceChoice) && (
                                <p className="text-xs text-gray-700 mt-1">
                                  Protein: {meal.proteinChoice || 'None'} | Veg: {meal.vegChoice || 'None'} | Carb: {meal.carbChoice || 'None'} | Sauce: {meal.sauceChoice || 'None'}
                                </p>
                              )}
                              <div className="mt-1 flex items-center gap-2 flex-wrap">
                                <span className="inline-block bg-green-600 text-white text-xs px-2 py-1 rounded font-medium capitalize">
                                  {['main', 'lunch', 'dinner'].includes(meal.mealType?.toLowerCase()) ? 'meal' : meal.mealType}
                                </span>
                                {meal.quantity > 1 && (
                                  <span className="inline-block bg-indigo-600 text-white text-xs px-2 py-1 rounded font-medium">
                                    × {meal.quantity}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => {
                setInlineLimitError(null);
                setShowExclusionModal(false);
                setShowRemainingModal(false);
                setShowBreakfastModal(false);
                setPendingSelection(null);
                setPendingNavAction(null);
                setPendingBreakfastSelection(null);
                setAcknowledgeExclusion(false);
                setAcknowledgeRemaining(false);
                setAcknowledgeBreakfast(false);
                setSkippedDateKeys([]);
                setMealIndex(0);
                setError(null);
                setStep('meals');
              }}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 rounded-lg transition"
            >
              Edit Selections
            </button>

            <button
              onClick={() => {
                setStep('email');
                setEmail('');
                setSelectedMeals([]);
                setSkippedDateKeys([]);
                setMealIndex(0);
                setError(null);
              }}
              className="w-full border border-gray-300 text-gray-700 hover:bg-gray-50 font-semibold py-2 rounded-lg transition"
            >
              Select Meals Again
            </button>
          </div>
          {/* Macros Modal (duplicate for completion view) */}
          {showMacrosModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={() => setShowMacrosModal(false)}>
              <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-bold mb-3">Add Macros (C / P / F)</h3>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="text-xs text-gray-600">Carbs (g)</label>
                    <input type="number" value={macrosInput.C} onChange={(e) => setMacrosInput({ ...macrosInput, C: e.target.value })} className="w-full px-3 py-2 border rounded" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Protein (g)</label>
                    <input type="number" value={macrosInput.P} onChange={(e) => setMacrosInput({ ...macrosInput, P: e.target.value })} className="w-full px-3 py-2 border rounded" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Fat (g)</label>
                    <input type="number" value={macrosInput.F} onChange={(e) => setMacrosInput({ ...macrosInput, F: e.target.value })} className="w-full px-3 py-2 border rounded" />
                  </div>
                </div>

                <div className="mb-3">
                  <h4 className="font-semibold">Breakfast preset (optional)</h4>
                  <div className="grid grid-cols-3 gap-3 mt-2">
                    <input type="number" placeholder="C" value={breakfastPreset.C} onChange={(e) => setBreakfastPreset({ ...breakfastPreset, C: e.target.value })} className="px-3 py-2 border rounded" />
                    <input type="number" placeholder="P" value={breakfastPreset.P} onChange={(e) => setBreakfastPreset({ ...breakfastPreset, P: e.target.value })} className="px-3 py-2 border rounded" />
                    <input type="number" placeholder="F" value={breakfastPreset.F} onChange={(e) => setBreakfastPreset({ ...breakfastPreset, F: e.target.value })} className="px-3 py-2 border rounded" />
                  </div>
                </div>

                <div className="mb-3">
                  <h4 className="font-semibold">Snack preset (optional)</h4>
                  <div className="grid grid-cols-3 gap-3 mt-2">
                    <input type="number" placeholder="C" value={snackPreset.C} onChange={(e) => setSnackPreset({ ...snackPreset, C: e.target.value })} className="px-3 py-2 border rounded" />
                    <input type="number" placeholder="P" value={snackPreset.P} onChange={(e) => setSnackPreset({ ...snackPreset, P: e.target.value })} className="px-3 py-2 border rounded" />
                    <input type="number" placeholder="F" value={snackPreset.F} onChange={(e) => setSnackPreset({ ...snackPreset, F: e.target.value })} className="px-3 py-2 border rounded" />
                  </div>
                </div>

                <div className="flex gap-3 justify-end">
                  <button onClick={() => { computeMacrosPreview(); }} className="px-4 py-2 border rounded">Preview</button>
                  <button onClick={handleSaveMacros} className="px-4 py-2 bg-indigo-600 text-white rounded">Save</button>
                </div>

                {macrosPreview && (
                  <div className="mt-4 bg-gray-50 border p-3 rounded">
                    <div className="text-sm">Total Calories: <strong>{macrosPreview.total.calories}</strong></div>
                    <div className="text-sm mt-2">Per-meal breakdown (C / P / F / V):</div>
                    <div className="mt-2 space-y-1 text-sm">
                      {macrosPreview.perMeal.map((m, i) => (
                        <div key={i}>Meal {i + 1}: {m.C}g / {m.P}g / {m.F}g / {m.V}g</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
};

export default MenuSelection;



