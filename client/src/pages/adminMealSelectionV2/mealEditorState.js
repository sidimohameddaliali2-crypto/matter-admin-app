// Normalize legacy/imported components before the simplified editor reads them.
// Do this once on entry, so exclusions deliberately removed in the editor stay removed.
export function editorComponents(meal, kind, isSaladBase) {
  const components = meal.components.map(c => ({ ...c, exclusions: [...(c.exclusions || [])] }));
  if (kind === 'Snack') {
    const snack = components.find(c => c.type === 'Snack');
    return [{ ...(snack || { id: `${meal.id}-snack`, type: 'Snack', notes: '', adaptation: 'Not reviewed' }), name: meal.name, exclusions: [...new Set(components.flatMap(c => c.exclusions))] }];
  }
  if (kind === 'Main meal' && isSaladBase) {
    const vegetables = components.filter(c => ['Vegetable', 'Salad'].includes(c.type));
    if (vegetables.length) {
      const first = vegetables.find(c => c.type === 'Salad') || vegetables[0];
      const salad = { ...first, type: 'Salad', name: vegetables.map(c => c.name).filter(Boolean).join(' + '), exclusions: [...new Set(vegetables.flatMap(c => c.exclusions))], notes: vegetables.map(c => c.notes).filter(Boolean).join('\n') };
      return components.filter(c => !['Vegetable', 'Salad'].includes(c.type)).map(c => c.type === 'Sauce 2' ? { ...c, saladComponentId: salad.id } : c).concat(salad);
    }
  }
  return components.map(c => {
    // Breakfast has no salad section: retain legacy Sauce 2 in its editable extras.
    if (kind === 'Breakfast' && c.type === 'Sauce 2') return { ...c, type: 'Extra sauce / topping' };
    return c.type === 'Breakfast' ? { ...c, type: 'Protein' } : c;
  });
}
