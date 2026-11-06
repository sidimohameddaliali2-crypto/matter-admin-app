import { MENU_EXCEL_HEADERS, parseCorePlanFlag, corePlanExcelValue } from './menuExcelCore';

test.each([true, 'TRUE', ' true ', 1])('Core Excel flag accepts true: %p', value => {
  expect(parseCorePlanFlag(value)).toBe(true);
});
test.each([false, 'FALSE', ' false ', 0])('Core Excel flag accepts false without treating the text as truthy: %p', value => {
  expect(parseCorePlanFlag(value)).toBe(false);
});
test('blank and legacy uploads leave existing eligibility unspecified; malformed values fail clearly', () => {
  expect(MENU_EXCEL_HEADERS.slice(-1)).toEqual(['CORE PLAN']);
  expect(MENU_EXCEL_HEADERS.indexOf('GARNISH')).toBe(9);
  expect(parseCorePlanFlag(undefined)).toBeUndefined();
  expect(parseCorePlanFlag('')).toBeUndefined();
  expect(() => parseCorePlanFlag('maybe')).toThrow('TRUE or FALSE');
  expect(parseCorePlanFlag(corePlanExcelValue(true))).toBe(true);
  expect(parseCorePlanFlag(corePlanExcelValue(false))).toBe(false);
});
