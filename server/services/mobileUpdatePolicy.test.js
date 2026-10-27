import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileUpdatePolicy } from './mobileUpdatePolicy.js';

test('required updates remain disabled until configured', () => {
  assert.equal(mobileUpdatePolicy({}).android.minimumBuild, 0);
});
test('minimum Android build uses safe integers and rejects bad configuration', () => {
  assert.equal(mobileUpdatePolicy({ MOBILE_ANDROID_MIN_BUILD: '30' }).android.minimumBuild, 30);
  for (const value of ['-1', 'foo', '1.2', '999999999999999999999']) {
    assert.equal(mobileUpdatePolicy({ MOBILE_ANDROID_MIN_BUILD: value }).android.minimumBuild, 0);
  }
});
test('message can be configured and is bounded', () => {
  assert.equal(mobileUpdatePolicy({ MOBILE_UPDATE_MESSAGE: 'New release available' }).android.message, 'New release available');
  assert.equal(mobileUpdatePolicy({ MOBILE_UPDATE_MESSAGE: 'x'.repeat(800) }).android.message.length, 500);
});
