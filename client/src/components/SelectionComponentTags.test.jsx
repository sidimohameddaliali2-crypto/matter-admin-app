import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SelectionComponentTags from './SelectionComponentTags';
import { selectionHasWarning, selectionComponentDetails } from '../utils/selectionComponentDetails';

test('kept portion or combined-meal exclusions highlight without side instructions, including old generic actions', () => {
  for (const meal of [{ preferenceConflict: ['Coriander'] }, { preferenceConflict: ['Dairy'], carbVegAction: 'kept' }]) {
    expect(selectionHasWarning(meal)).toBe(true);
    expect(selectionComponentDetails(meal)).toEqual([]);
  }
});

test.each([
  [{carbVegAction:'replace',carbConflict:['DAIRY']},'Replace carb: Dairy'],
  [{carbVegAction:'replace',vegConflict:['RAW ONION']},'Replace veg: Raw Onion'],
  [{carbVegAction:'replace',carbConflict:['DAIRY'],vegConflict:['MUSHROOM']},'Replace carb: DairyReplace veg: Mushroom'],
  [{carbVegAction:'kept',keptCarbConflict:['DAIRY'],keptVegConflict:['MUSHROOM']},'Keep carb: DairyKeep veg: Mushroom'],
  [{carbVegAction:'kept',carbConflict:['DAIRY'],vegConflict:['MUSHROOM']},'Keep carb: DairyKeep veg: Mushroom'],
  [{carbVegAction:'kept',keptCarbConflict:[],carbConflict:['DAIRY']},''],
  [{carbVegAction:'replace',keptCarbConflict:['DAIRY'],vegConflict:['CORIANDER']},'Replace veg: CorianderKeep carb: Dairy'],
])('tags show the exact component and exclusions (%s)', (meal, expected) => {
  global.IS_REACT_ACT_ENVIRONMENT=true;
  const node=document.createElement('div'), root=createRoot(node);
  try { act(()=>root.render(<SelectionComponentTags meal={meal}/>));expect(node.textContent).toBe(expected); }
  finally { act(()=>root.unmount()); }
});
