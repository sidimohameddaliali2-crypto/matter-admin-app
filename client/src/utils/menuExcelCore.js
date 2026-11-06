// Append new columns so previous six-/ten-column uploads keep their layout.
export const MENU_EXCEL_HEADERS = [
  'MEAL TYPE', 'INTOLERANCES', 'DAY', 'MEAL NAME', 'CARB', 'VEG', 'SLOT', 'PROTEIN TYPE', 'SAUCE', 'GARNISH', 'CORE PLAN',
];

export const parseCorePlanFlag = value => {
  if (value == null || String(value).trim() === '') return undefined;
  const flag = String(value).trim().toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  throw new Error('CORE PLAN must be TRUE or FALSE.');
};

export const corePlanExcelValue = value => value === true ? 'TRUE' : 'FALSE';
