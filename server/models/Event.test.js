import { test } from 'node:test';
import assert from 'node:assert/strict';
import Event from './Event.js';

const makeEvent = (venueType) => new Event({
  eventName: 'Meal plan delivery',
  companyName: 'Matter',
  eventDate: new Date('2026-10-22T08:00:00Z'),
  emirate: 'Dubai',
  venue: { type: venueType, address: 'Test address' },
  arrivalTime: '15:00'
});

test('events accept custom venue names on creation and subsequent edits', () => {
  const event = makeEvent('To go with delivery of meal plan');
  assert.equal(event.validateSync(), undefined);
  assert.equal(event.venue.type, 'To go with delivery of meal plan');

  event.venue.type = 'Another custom venue';
  assert.equal(event.validateSync(), undefined);
});

test('existing venue options remain valid', () => {
  for (const type of ['Private Villa', 'Hotel', 'Restaurant', 'Beach', 'Park', 'Convention Center', 'Gym', 'Outdoor Set up', 'Other']) {
    assert.equal(makeEvent(type).validateSync(), undefined);
  }
});

test('venue names are trimmed and must not be blank', () => {
  assert.equal(makeEvent('  Custom venue  ').venue.type, 'Custom venue');
  for (const type of [undefined, null, '', '   ']) {
    assert.ok(makeEvent(type).validateSync()?.errors['venue.type']);
  }
});
