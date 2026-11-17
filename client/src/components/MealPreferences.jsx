import React, { useState, useEffect } from 'react';
import { recordActivityChange } from '../utils/activityCapture';
import {
  Coffee,
  Apple,
  AlertCircle,
  Check,
  Loader,
  Eye,
  EyeOff
} from 'lucide-react';
import api from '../utils/api';
import { EXCLUSION_LIST, groupExclusions } from '../constants/exclusionList';

const MealPreferences = ({ customerId, customerEmail }) => {
  const [mealProfile, setMealProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [expandedSection, setExpandedSection] = useState('overview');
  const [exclusionSearch, setExclusionSearch] = useState('');
  // Menu Selection Partners — only fetched once editing starts (the "link to
  // a partner" dropdown is the only thing that needs the list).
  const [partners, setPartners] = useState([]);

  useEffect(() => {
    if (!isEditing || partners.length) return;
    api.get('/admin/partners?limit=200')
      .then((res) => setPartners(res.data?.data || []))
      .catch(() => {});
  }, [isEditing, partners.length]);

  useEffect(() => {
    if (customerId) {
      fetchMealProfile();
    } else {
      setLoading(false);
    }
  }, [customerId, customerEmail]);

  const fetchMealProfile = async () => {
    try {
      setLoading(true);
      // Pass email as query parameter if available to trigger Athleat sync
      // _t param busts any browser or HTTP cache
      const base = customerEmail && customerEmail !== 'N/A'
        ? `/menus/customers/${customerId}/meal-profile?email=${encodeURIComponent(customerEmail)}`
        : `/menus/customers/${customerId}/meal-profile`;
      const url = `${base}${base.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      
      const response = await api.get(url);
      if (response.data?.success) {
        setMealProfile(response.data.data);
        setFormData(response.data.data);
      }
    } catch (err) {
      console.error('Error fetching meal profile:', err);
      setError(err.response?.data?.message || 'Failed to load meal preferences');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      const payload = {
        mealPerDay: formData.mealPerDay,
        breakfastInclude: formData.breakfastInclude,
        mealSnack: formData.mealSnack,
        snackCount: formData.snackCount,
        mealPlan: formData.mealPlan,
        mealExclusion: formData.mealExclusion,
        allergies: formData.allergies,
        dietaryRestrictions: formData.dietaryRestrictions,
        preferences: formData.preferences,
        weekend: !!formData.weekend,
        partner: formData.partner
          ? (typeof formData.partner === 'object' ? formData.partner._id : formData.partner)
          : null,
        unlimitedMeals: !!formData.unlimitedMeals
      };
      const response = await api.post(
        `/menus/customers/${customerId}/meal-profile`,
        payload
      );
      if (response.data?.success) {
        // Update display state directly from what we just saved — no re-fetch needed
        const updated = { ...mealProfile, ...payload };
        setMealProfile(updated);
        setFormData(updated);
        setIsEditing(false);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save preferences');
    } finally {
      setLoading(false);
    }
  };

  if (loading && !mealProfile) {
    return (
      <div className="flex items-center justify-center p-6">
        <Loader className="animate-spin text-indigo-600" size={24} />
      </div>
    );
  }

  if (!mealProfile) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex gap-3">
        <AlertCircle className="text-yellow-600 flex-shrink-0" size={20} />
        <div>
          <p className="font-semibold text-yellow-700">No meal profile found</p>
          <p className="text-yellow-600 text-sm">
            {customerId 
              ? customerEmail ? 'Meal preferences have not been set up for this customer yet.' : 'Please add customer email to load meal preferences from FileMaker. Use the "Add Email" button in Contact Information.'
              : 'Customer ID is required to manage meal preferences.'}
          </p>
        </div>
      </div>
    );
  }

  const MACRO_PLAN_MAP = [
    { C: 70,  P: 60,  F: 31,  plan: 'Lean 2 Meal' },
    { C: 115, P: 90,  F: 42,  plan: 'Lean 3 Meal' },
    { C: 130, P: 80,  F: 40,  plan: 'Thrive 2 Meal' },
    { C: 180, P: 120, F: 67,  plan: 'Thrive 3 Meal' },
    { C: 180, P: 100, F: 66,  plan: 'Perform 2 Meal' },
    { C: 225, P: 150, F: 100, plan: 'Perform 3 Meal' },
  ];
  const getMealPlanFromMacros = (C, P, F) => {
    const c = Math.round(Number(C) || 0);
    const p = Math.round(Number(P) || 0);
    const f = Math.round(Number(F) || 0);
    if (!c && !p && !f) return null;
    const match = MACRO_PLAN_MAP.find(m => m.C === c && m.P === p && m.F === f);
    return match ? match.plan : 'Customized';
  };

  const mealPlanBadgeColors = {
    'Standard':      'bg-blue-100 text-blue-700',
    'Customized':    'bg-purple-100 text-purple-700',
    'Premium':       'bg-yellow-100 text-yellow-700',
    'Vegan':         'bg-green-100 text-green-700',
    'Keto':          'bg-pink-100 text-pink-700',
    'Paleo':         'bg-orange-100 text-orange-700',
    'Bodybuilder':   'bg-red-100 text-red-700',
    'Lean 2 Meal':   'bg-sky-100 text-sky-700',
    'Lean 3 Meal':   'bg-sky-100 text-sky-700',
    'Thrive 2 Meal': 'bg-teal-100 text-teal-700',
    'Thrive 3 Meal': 'bg-teal-100 text-teal-700',
    'Perform 2 Meal':'bg-indigo-100 text-indigo-700',
    'Perform 3 Meal':'bg-indigo-100 text-indigo-700',
  };
  const mealPlanOptions = Object.keys(mealPlanBadgeColors);

  // Derive the plan from macros; fall back to whatever is stored
  const derivedPlan = getMealPlanFromMacros(
    mealProfile.macros?.C, mealProfile.macros?.P, mealProfile.macros?.F
  ) || mealProfile.mealPlan || 'Not Set';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold text-gray-900">Meal Preferences</h3>
        <div className="flex items-center gap-2">
          {isEditing && (
            <button
              onClick={handleSave}
              disabled={loading}
              className="px-4 py-2 rounded-lg transition text-sm font-semibold bg-green-600 text-white hover:bg-green-700 disabled:bg-gray-400"
            >
              {loading ? (
                <>
                  <Loader className="inline animate-spin mr-2" size={16} />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </button>
          )}
          <button
            onClick={() => {
              if (isEditing) {
                const labels = { mealPerDay: 'Meals per day', breakfastInclude: 'Breakfast included', mealSnack: 'Snacks included', snackCount: 'Snack count', mealPlan: 'Meal plan', mealExclusion: 'Meal exclusions', allergies: 'Allergies', dietaryRestrictions: 'Dietary restrictions', preferences: 'Dietary preferences', weekend: 'Weekend meals', partner: 'Partner', unlimitedMeals: 'Unlimited meals' };
                const display = (key, value) => key === 'partner' ? (value?.businessName || partners.find(partner => partner._id === (value?._id || value))?.businessName || (value ? `Partner ${value?._id || value}` : 'None')) : value;
                Object.entries(labels).forEach(([key, field]) => recordActivityChange({ field, form: 'Meal preferences', before: display(key, formData[key]), after: display(key, mealProfile[key]), private: ['mealExclusion', 'allergies', 'dietaryRestrictions', 'preferences'].includes(key) }));
                setFormData(mealProfile);
              }
              setIsEditing(!isEditing);
            }}
            className={`px-4 py-2 rounded-lg transition text-sm font-semibold ${
              isEditing
                ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                : 'bg-indigo-600 text-white hover:bg-indigo-700'
            }`}
          >
            {isEditing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0" size={20} />
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {/* Overview Section */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <button
          onClick={() =>
            setExpandedSection(
              expandedSection === 'overview' ? null : 'overview'
            )
          }
          className="w-full p-4 flex justify-between items-center hover:bg-gray-50 transition"
        >
          <h4 className="font-semibold text-gray-900 flex items-center gap-2">
            <Apple size={18} className="text-indigo-600" />
            Meal Overview
          </h4>
          {expandedSection === 'overview' ? (
            <EyeOff size={18} className="text-gray-400" />
          ) : (
            <Eye size={18} className="text-gray-400" />
          )}
        </button>

        {expandedSection === 'overview' && (
          <div className="p-4 border-t border-gray-200 space-y-4 bg-gray-50">
            {isEditing ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <label className="text-gray-600 text-sm block mb-1">Meals Per Day</label>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={formData.mealPerDay ?? 0}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        mealPerDay: e.target.value === '' ? '' : Number(e.target.value)
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <label className="text-gray-600 text-sm block mb-1">Partner (Menu Selection)</label>
                  <select
                    value={typeof formData.partner === 'object' ? (formData.partner?._id || '') : (formData.partner || '')}
                    onChange={(e) => {
                      const id = e.target.value;
                      const picked = partners.find((p) => p._id === id);
                      const unlimited = id && picked?.menuSelectionEnabled ? true : (id ? formData.unlimitedMeals : false);
                      recordActivityChange({ field: 'Unlimited meals', form: 'Meal preferences', before: !!formData.unlimitedMeals, after: !!unlimited });
                      setFormData((prev) => ({
                        ...prev,
                        partner: id || null,
                        unlimitedMeals: id && picked?.menuSelectionEnabled ? true : (id ? prev.unlimitedMeals : false)
                      }));
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— None —</option>
                    {partners.map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.businessName}{p.menuSelectionEnabled ? ' · Menu Selection' : ''}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-sm text-gray-700 mt-2">
                    <input
                      type="checkbox"
                      checked={!!formData.unlimitedMeals}
                      onChange={(e) => setFormData((prev) => ({ ...prev, unlimitedMeals: e.target.checked }))}
                      className="w-4 h-4 accent-blue-600"
                    />
                    Unlimited meals (no daily cap)
                  </label>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <label className="text-gray-600 text-sm block mb-1">Meal Plan</label>
                  <select
                    value={formData.mealPlan || derivedPlan || 'Standard'}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        mealPlan: e.target.value
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  >
                    {mealPlanOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                <div className="bg-white p-3 rounded-lg border border-gray-200 flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="pref-weekend"
                    checked={!!formData.weekend}
                    onChange={(e) => setFormData(p => ({ ...p, weekend: e.target.checked }))}
                    className="w-4 h-4 accent-blue-600"
                  />
                  <label htmlFor="pref-weekend" className="text-sm font-medium text-gray-700">Enable Weekend (Sat & Sun)</label>
                </div>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <label className="text-gray-600 text-sm block mb-1">Breakfast</label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={!!formData.breakfastInclude}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          breakfastInclude: e.target.checked
                        })
                      }
                    />
                    Included
                  </label>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <label className="text-gray-600 text-sm block mb-1">Snacks</label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={!!formData.mealSnack}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          mealSnack: e.target.checked
                        })
                      }
                    />
                    Included
                  </label>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <label className="text-gray-600 text-sm block mb-1">Snack Count</label>
                  <input
                    type="number"
                    min={0}
                    value={formData.snackCount ?? 0}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        snackCount: e.target.value === '' ? '' : Number(e.target.value)
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <p className="text-gray-600 text-sm">Meals Per Day</p>
                  <p className="text-2xl font-bold text-indigo-600">
                    {mealProfile.unlimitedMeals ? 'Unlimited' : (mealProfile.mealPerDay || 0)}
                  </p>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <p className="text-gray-600 text-sm">Partner</p>
                  <p className="text-sm font-semibold text-gray-800">
                    {mealProfile.partner?.businessName || '—'}
                  </p>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <p className="text-gray-600 text-sm">Meal Plan</p>
                  <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${mealPlanBadgeColors[derivedPlan] || 'bg-gray-100 text-gray-700'}`}>
                    {derivedPlan}
                  </span>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <p className="text-gray-600 text-sm">Breakfast</p>
                  <div className="flex items-center gap-2">
                    {mealProfile.breakfastInclude ? (
                      <>
                        <Check className="text-green-600" size={20} />
                        <span className="font-semibold text-green-600">Included</span>
                      </>
                    ) : (
                      <span className="font-semibold text-gray-600">Not Included</span>
                    )}
                  </div>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <p className="text-gray-600 text-sm">Snacks</p>
                  <div className="flex items-center gap-2">
                    {mealProfile.mealSnack ? (
                      <>
                        <Check className="text-green-600" size={20} />
                        <span className="font-semibold text-green-600">Included</span>
                      </>
                    ) : (
                      <span className="font-semibold text-gray-600">Not Included</span>
                    )}
                  </div>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <p className="text-gray-600 text-sm">Snack Count</p>
                  <p className="text-2xl font-bold text-indigo-600">
                    {mealProfile.snackCount || 0}
                  </p>
                </div>

                <div className="bg-white p-3 rounded-lg border border-gray-200">
                  <p className="text-gray-600 text-sm">Weekend</p>
                  <div className="flex items-center gap-2">
                    {mealProfile.weekend ? (
                      <>
                        <Check className="text-green-600" size={20} />
                        <span className="font-semibold text-green-600">Enabled (Sat & Sun)</span>
                      </>
                    ) : (
                      <span className="font-semibold text-gray-600">Disabled (stops on Fri)</span>
                    )}
                  </div>
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {/* Details Section */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <button
          onClick={() =>
            setExpandedSection(expandedSection === 'details' ? null : 'details')
          }
          className="w-full p-4 flex justify-between items-center hover:bg-gray-50 transition"
        >
          <h4 className="font-semibold text-gray-900 flex items-center gap-2">
            <Coffee size={18} className="text-indigo-600" />
            Dietary Details
          </h4>
          {expandedSection === 'details' ? (
            <EyeOff size={18} className="text-gray-400" />
          ) : (
            <Eye size={18} className="text-gray-400" />
          )}
        </button>

        {expandedSection === 'details' && (
          <div className="p-4 border-t border-gray-200 space-y-4 bg-gray-50">
            {isEditing ? (
              <>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Allergies
                  </label>
                  <input
                    type="text"
                    value={formData.allergies?.join(', ') || ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        allergies: e.target.value.split(',').map(a => a.trim()).filter(Boolean)
                      })
                    }
                    placeholder="e.g., peanuts, shellfish, gluten"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Dietary Restrictions
                  </label>
                  <input
                    type="text"
                    value={formData.dietaryRestrictions?.join(', ') || ''}
                    data-activity-private
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        dietaryRestrictions: e.target.value.split(',').map(r => r.trim())
                      })
                    }
                    placeholder="e.g., vegetarian, vegan, kosher"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Additional Preferences
                  </label>
                  <textarea
                    value={formData.preferences || ''}
                    data-activity-private
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        preferences: e.target.value
                      })
                    }
                    placeholder="Any other dietary preferences or notes..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                    rows={3}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Meal Exclusions
                  </label>
                  {(() => {
                    const selected = new Set(
                      groupExclusions(formData.mealExclusion || '').map((p) => p.toLowerCase())
                    );
                    const filtered = exclusionSearch.trim()
                      ? EXCLUSION_LIST.filter((p) =>
                          p.toLowerCase().includes(exclusionSearch.trim().toLowerCase())
                        )
                      : EXCLUSION_LIST;
                    const toggle = (phrase) => {
                      const key = phrase.toLowerCase();
                      const next = new Set(selected);
                      if (next.has(key)) next.delete(key); else next.add(key);
                      const newVal = EXCLUSION_LIST
                        .filter((p) => next.has(p.toLowerCase()))
                        .join(',');
                      setFormData({ ...formData, mealExclusion: newVal });
                    };
                    return (
                      <div className="border border-gray-300 rounded-lg overflow-hidden">
                        <input
                          type="text"
                          value={exclusionSearch}
                          onChange={(e) => setExclusionSearch(e.target.value)}
                          placeholder="Search exclusions..."
                          className="w-full px-3 py-2 border-b border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                        <div className="max-h-52 overflow-y-auto p-2 grid grid-cols-2 gap-1">
                          {filtered.map((phrase) => (
                            <label key={phrase} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-gray-50 text-sm">
                              <input
                                type="checkbox"
                                checked={selected.has(phrase.toLowerCase())}
                                data-activity-label="Dietary exclusions"
                                data-activity-private
                                onChange={() => toggle(phrase)}
                                className="h-4 w-4 rounded accent-indigo-600"
                              />
                              <span>{phrase}</span>
                            </label>
                          ))}
                        </div>
                        {selected.size > 0 && (
                          <div className="border-t border-gray-200 px-3 py-2 flex flex-wrap gap-1">
                            {EXCLUSION_LIST.filter((p) => selected.has(p.toLowerCase())).map((p) => (
                              <span key={p} className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full text-xs font-semibold">{p}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <div className="flex gap-2 pt-2">
                </div>
              </>
            ) : (
              <>
                {mealProfile.allergies?.length > 0 && (
                  <div>
                    <p className="text-sm text-gray-600 font-semibold mb-2">
                      Allergies
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {mealProfile.allergies.map((allergy, idx) => (
                        <span
                          key={idx}
                          className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-sm"
                        >
                          {allergy}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {mealProfile.dietaryRestrictions?.length > 0 && (
                  <div>
                    <p className="text-sm text-gray-600 font-semibold mb-2">
                      Dietary Restrictions
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {mealProfile.dietaryRestrictions.map((restriction, idx) => (
                        <span
                          key={idx}
                          className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-sm"
                        >
                          {restriction}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {mealProfile.preferences && (
                  <div>
                    <p className="text-sm text-gray-600 font-semibold mb-2">
                      Additional Preferences
                    </p>
                    <p className="text-gray-700 text-sm">{mealProfile.preferences}</p>
                  </div>
                )}

                {mealProfile.mealExclusion && (
                  <div>
                    <p className="text-sm text-gray-600 font-semibold mb-2">
                      Meal Exclusions
                    </p>
                    {(() => {
                      const exclusions = groupExclusions(mealProfile.mealExclusion);
                      return exclusions.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {exclusions.map((item, idx) => (
                            <span
                              key={idx}
                              className="bg-purple-100 text-purple-700 px-3 py-1 rounded-full text-sm"
                            >
                              {item}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-gray-700 text-sm">{mealProfile.mealExclusion}</p>
                      );
                    })()}
                  </div>
                )}

                {!mealProfile.allergies?.length &&
                  !mealProfile.dietaryRestrictions?.length &&
                  !mealProfile.preferences &&
                  !mealProfile.mealExclusion && (
                    <p className="text-gray-500 text-sm italic">No additional details provided</p>
                  )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MealPreferences;
