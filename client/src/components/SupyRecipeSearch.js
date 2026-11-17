import React, { useEffect, useRef, useState } from 'react';
import api from '../utils/api';
import { activityReference, recordActivityChange } from '../utils/activityCapture';

// Typeahead over Supy recipes. Renders a text input the user types a recipe
// name into; after a short pause it searches Supy and shows matches below
// the input. Picking one hands the full recipe (name + ingredients) back to
// the caller via onSelect — the caller decides what to do with the ingredients
// (a lunch/dinner meal merges per-component, breakfast/snack uses it whole).
const SupyRecipeSearch = ({ value, onChangeText, onSelect, placeholder, className, activityLabel = 'Recipe', activityScope }) => {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);
  const containerRef = useRef(null);
  const selectedRecipe = useRef(null);

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const runSearch = (text) => {
    clearTimeout(debounceRef.current);
    if (!text || text.trim().length < 2) {
      setResults([]);
      setIsLoading(false);
      setHasSearched(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    // A cold cache (first search after ~10min idle) fetches ~2500 Supy
    // recipes and can take several seconds — this timeout is generous on
    // purpose so a slow-but-working search doesn't look identical to "no
    // matches" (that ambiguity is exactly what caused a real miss to go
    // unnoticed before this had visible error/empty states).
    debounceRef.current = setTimeout(async () => {
      try {
        const response = await api.get('/menus/supy-recipes/search', { params: { q: text.trim() }, timeout: 30000 });
        setResults(response.data?.data || []);
        setHasSearched(true);
      } catch (err) {
        setResults([]);
        setHasSearched(true);
        setError(err.response?.data?.message || err.message || 'Search failed');
      } finally {
        setIsLoading(false);
      }
    }, 300);
  };

  const handleChange = (e) => {
    const text = e.target.value;
    setQuery(text);
    setIsOpen(true);
    onChangeText?.(text);
    runSearch(text);
  };

  const handleSelect = (recipe) => {
    const scope = activityScope ?? activityLabel;
    const previousId = selectedRecipe.current?.scope === scope && selectedRecipe.current.name === value ? selectedRecipe.current.id : undefined;
    const id = recipe.id ?? recipe._id;
    recordActivityChange({ field: activityLabel, form: 'Weekly menu meal', before: value ? activityReference(value, previousId) : '', after: activityReference(recipe.name, id), element: containerRef.current });
    selectedRecipe.current = { scope, name: recipe.name, id };
    setQuery(recipe.name);
    setIsOpen(false);
    setResults([]);
    onSelect?.(recipe);
  };

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        data-activity-label={activityLabel}
        value={query}
        onChange={handleChange}
        onFocus={() => { if (results.length) setIsOpen(true); }}
        className={className || 'w-full px-3 py-2 border border-matter-neutral-300 rounded-lg focus:ring-2 focus:ring-matter-sky text-sm'}
        placeholder={placeholder}
        autoComplete="off"
      />
      {isOpen && (isLoading || results.length > 0 || error || hasSearched) && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-matter-neutral-300 rounded-lg shadow-lg">
          {isLoading && (
            <div className="px-3 py-2 text-xs text-matter-neutral-500">Searching Supy…</div>
          )}
          {!isLoading && error && (
            <div className="px-3 py-2 text-xs text-matter-red">Search failed: {error}</div>
          )}
          {!isLoading && !error && hasSearched && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-matter-neutral-500">No matching Supy recipes</div>
          )}
          {!isLoading && results.map((recipe) => (
            <button
              type="button"
              key={recipe.id}
              onClick={() => handleSelect(recipe)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-matter-neutral-100 flex items-center justify-between gap-2"
            >
              <span className="truncate">{recipe.name}</span>
              {recipe.category && (
                <span className="text-[10px] text-matter-neutral-500 shrink-0">{recipe.category}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default SupyRecipeSearch;
