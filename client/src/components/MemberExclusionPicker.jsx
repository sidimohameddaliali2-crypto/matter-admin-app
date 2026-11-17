import React, { useState, useMemo } from 'react';
import { EXCLUSION_LIST, groupExclusions } from '../constants/exclusionList';

/*
 * Dietary-exclusion picker for the member flow.
 * Controlled: `value` is a comma-joined string, `onChange(nextString)`.
 * Adapted from the checkbox-grid in components/MealPreferences.jsx.
 * `light` switches from the MATTER dark shell (Partner portal) to the
 * white/navy "Organic" skin used by the member ordering flow.
 */
const MemberExclusionPicker = ({ value = '', onChange, light = false }) => {
  const [search, setSearch] = useState('');

  const selected = useMemo(
    () => new Set(groupExclusions(value || '').map((p) => p.toLowerCase())),
    [value]
  );

  const filtered = search.trim()
    ? EXCLUSION_LIST.filter((p) => p.toLowerCase().includes(search.trim().toLowerCase()))
    : EXCLUSION_LIST;

  const toggle = (phrase) => {
    const key = phrase.toLowerCase();
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange(EXCLUSION_LIST.filter((p) => next.has(p.toLowerCase())).join(','));
  };

  const wrap = light
    ? 'border border-[#dde4f0] rounded-2xl overflow-hidden bg-white'
    : 'border-[1.5px] border-[#12275e] rounded-[16px] overflow-hidden bg-[#0a1230]';
  const searchCls = light
    ? 'w-full px-3.5 py-2.5 bg-transparent border-b border-[#dde4f0] text-[13px] text-[#051747] placeholder-[#8e9bb8] outline-none'
    : 'w-full px-3.5 py-2.5 bg-transparent border-b border-[#12275e] text-[13px] text-[#ede5de] placeholder-[#5b7099] outline-none';
  const rowHover = light ? 'hover:bg-[#eef2f9]' : 'hover:bg-[#12275e]';
  const onText = light ? 'text-[#1b60b4] font-semibold' : 'text-[#bcf679] font-semibold';
  const offText = light ? 'text-[#4a5a7d]' : 'text-[#a8ccf5]';
  const accent = light ? 'accent-[#1b60b4]' : 'accent-[#bcf679]';
  const chipsWrap = light ? 'border-t border-[#dde4f0] px-3 py-2 flex flex-wrap gap-1' : 'border-t border-[#12275e] px-3 py-2 flex flex-wrap gap-1';
  const chip = light
    ? 'bg-[#eef5ff] text-[#1b60b4] px-2 py-0.5 rounded-full text-[11px] font-bold'
    : 'bg-[rgba(188,246,121,.15)] text-[#bcf679] px-2 py-0.5 rounded-full text-[11px] font-bold';

  return (
    <div className={wrap} data-activity-private>
      <input
        type="text"
        data-activity-label="Dietary exclusion search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search exclusions…"
        className={searchCls}
      />
      <div className="max-h-52 overflow-y-auto p-2 grid grid-cols-2 gap-0.5">
        {filtered.map((phrase) => {
          const on = selected.has(phrase.toLowerCase());
          return (
            <label key={phrase} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-[12.5px] ${rowHover}`}>
              <input
                type="checkbox"
                data-activity-label="Dietary exclusions"
                checked={on}
                onChange={() => toggle(phrase)}
                className={`h-3.5 w-3.5 rounded ${accent}`}
              />
              <span className={on ? onText : offText}>{phrase}</span>
            </label>
          );
        })}
      </div>
      {selected.size > 0 && (
        <div className={chipsWrap}>
          {EXCLUSION_LIST.filter((p) => selected.has(p.toLowerCase())).map((p) => (
            <span key={p} className={chip}>{p}</span>
          ))}
        </div>
      )}
    </div>
  );
};

export default MemberExclusionPicker;
