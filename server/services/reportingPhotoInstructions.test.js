import assert from 'node:assert/strict';
import test from 'node:test';
import { reportingPhotoInstructions } from './reportingPhotoInstructions.js';

test('only an explicit dated instruction establishes an approved alternate', () => {
  const gate = reportingPhotoInstructions({ additionalDetails: 'Please leave the bag at the front gate.' });
  assert.equal(gate.approvedPlace, 'gate');
  assert.match(gate.instructionSha256, /^[a-f0-9]{64}$/);
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'Leave the bag on the reception shelf' }).approvedPlace, 'reception_shelf');
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'Hand to reception' }).approvedPlace, null);
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'If nobody answers, leave the bag at the gate' }).approvedPlace, null);
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'Do not leave the bag at the gate' }).approvedPlace, null);
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'Leave the bag at the gate', additional_details: 'Leave it at the door' }).approvedPlace, null);
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'Leave it at the apartment door' }).approvedPlace, 'door');
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'Do not leave at the front door. Use the side gate.' }).placementUncertain, true);
  assert.equal(reportingPhotoInstructions({ additionalDetails: 'Gate code 1234' }).placementUncertain, undefined);
  assert.equal(reportingPhotoInstructions({ additionalDetails: '   ' }), null);
  assert.deepEqual(Object.keys(gate).sort(), ['approvedPlace', 'instructionSha256']);
});

test('the dated address only corroborates a distinctly labelled villa number', () => {
  assert.equal(reportingPhotoInstructions({ locationType: 'Villa' }, 'Villa TH-42, Example Street').verifiedVillaNumber, 'TH-42');
  assert.equal(reportingPhotoInstructions({ locationType: 'Villa' }, 'Villa 42 or 43, Example Street'), null);
  assert.equal(reportingPhotoInstructions({ locationType: 'Villa' }, 'Villa 42, Villa 43'), null);
  assert.equal(reportingPhotoInstructions({ locationType: 'Villa' }, 'Unit 42, Example Street'), null);
  assert.equal(reportingPhotoInstructions({ locationType: 'Apartment' }, 'Villa 42, Example Street'), null);
});
