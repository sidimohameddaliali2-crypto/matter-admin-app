import test from 'node:test';
import assert from 'node:assert/strict';
import { displayMatterName } from './matterName.js';

test('a mixed-case Matter name is kept exactly as Matter has it', () => {
  assert.equal(displayMatterName('Charlie Casella'), 'Charlie Casella');
  assert.equal(displayMatterName('Emily de Rooy'), 'Emily de Rooy');
  assert.equal(displayMatterName('Agustin morales'), 'Agustin morales');
});

test('all-lowercase and ALL CAPS names are tidied to Title Case', () => {
  assert.equal(displayMatterName('chiara hardie'), 'Chiara Hardie');
  assert.equal(displayMatterName('NATHALIE PAGEAU'), 'Nathalie Pageau');
  assert.equal(displayMatterName("o'neil mary-jane"), "O'Neil Mary-Jane");
});

test('extra spaces are collapsed and empty values give an empty string', () => {
  assert.equal(displayMatterName('  Dmitriy   Poliakovskyi '), 'Dmitriy Poliakovskyi');
  assert.equal(displayMatterName(''), '');
  assert.equal(displayMatterName(null), '');
  assert.equal(displayMatterName(undefined), '');
});

test('non-Latin names: Arabic is untouched, lowercase Cyrillic is capitalised', () => {
  assert.equal(displayMatterName('أحمد'), 'أحمد');
  assert.equal(displayMatterName('м к'), 'М К');
});
