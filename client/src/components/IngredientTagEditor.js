import React, { useState } from 'react';
import { X } from 'lucide-react';
import { recordActivityChange } from '../utils/activityCapture';

// One ingredient tag per item: click the tag to toggle it between "shown to
// the customer" (filled/green) and "backend only" (outlined/muted) — used
// for exclusion/allergen matching either way, since hiding an ingredient
// from display must never hide it from a safety check. The × removes it
// entirely, and the small input below adds one not pulled from Supy.
const IngredientTagEditor = ({ value, onChange, activityLabel = 'Ingredients' }) => {
  const [draft, setDraft] = useState('');
  const tags = Array.isArray(value) ? value : [];
  const changeTags = (next) => {
    const describe = items => items.map(tag => `${tag.name} (${tag.visible ? 'shown to customer' : 'backend only'})`);
    recordActivityChange({ field: activityLabel, form: 'Weekly menu meal', before: describe(tags), after: describe(next) });
    onChange(next);
  };

  const toggleVisible = (index) => {
    const next = tags.map((tag, i) => (i === index ? { ...tag, visible: !tag.visible } : tag));
    changeTags(next);
  };

  const removeTag = (index) => {
    changeTags(tags.filter((_, i) => i !== index));
  };

  // A comma always splits into separate tags — typing "Salt, Pepper" commits
  // "Salt" as its own tag the moment the comma is typed, and Add/Enter
  // commits whatever's left (including a pasted "a, b, c" all at once).
  const commitNames = (text) => {
    const names = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    changeTags([...tags, ...names.map((name) => ({ name, visible: true }))]);
  };

  const handleDraftChange = (e) => {
    const val = e.target.value;
    if (val.includes(',')) {
      const parts = val.split(',');
      const remainder = parts.pop();
      commitNames(parts.join(','));
      setDraft(remainder);
      return;
    }
    setDraft(val);
  };

  const addTag = () => {
    commitNames(draft);
    setDraft('');
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-1.5 min-h-[26px]">
        {tags.length === 0 && (
          <span className="text-xs text-matter-neutral-400 italic">No ingredients yet</span>
        )}
        {tags.map((tag, index) => (
          <span
            key={`${tag.name}-${index}`}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
              tag.visible
                ? 'bg-matter-green/20 border-matter-green text-matter-navy'
                : 'bg-matter-neutral-200 border-matter-neutral-300 text-matter-neutral-600'
            }`}
          >
            <button
              type="button"
              onClick={() => toggleVisible(index)}
              title={tag.visible ? 'Shown to customer — click to hide' : 'Backend only — click to show customer'}
              className="cursor-pointer"
            >
              {tag.name}
            </button>
            <button
              type="button"
              onClick={() => removeTag(index)}
              className="text-matter-neutral-500 hover:text-matter-red"
              title="Remove ingredient"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          type="text"
          data-activity-label={`${activityLabel} draft`}
          value={draft}
          onChange={handleDraftChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder="Add an ingredient…"
          className="flex-1 px-2.5 py-1.5 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-xs"
        />
        <button
          type="button"
          onClick={addTag}
          className="px-2.5 py-1.5 text-xs border border-matter-neutral-300 rounded-lg text-matter-neutral-700 hover:bg-matter-neutral-100"
        >
          Add
        </button>
      </div>
      <p className="text-[10.5px] text-matter-neutral-500 mt-1">
        Green = shown to customer · grey = backend only (still checked for exclusions)
      </p>
    </div>
  );
};

export default IngredientTagEditor;
