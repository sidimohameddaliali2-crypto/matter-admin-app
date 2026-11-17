import authReducer, { refreshCurrentUser } from './authSlice';
import { updateUser } from './userSlice';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));

const user = { _id: 'fixture-current-user', role: 'admin', profile: { firstName: 'Before' }, permissions: { dashboard: true } };
const authenticated = (approval) => {
  const account = { ...user, ...(approval === undefined ? {} : { canViewActivityHistory: approval }) };
  localStorage.setItem('user', JSON.stringify(account));
  return authReducer(undefined, refreshCurrentUser.fulfilled(account, 'fixture-auth-refresh'));
};
const updateOwnAccount = (state, payload = {}) => authReducer(state, updateUser.fulfilled({ ...user, profile: { firstName: 'After' }, permissions: { dashboard: false, drivers: true }, ...payload }, 'fixture-account-update'));

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

test('preserves approved history access and its saved login when the own-account response omits it', () => {
  const next = updateOwnAccount(authenticated(true));
  expect(next.user.canViewActivityHistory).toBe(true);
  expect(next.user.profile.firstName).toBe('After');
  expect(next.user.permissions).toEqual({ dashboard: false, drivers: true });
  expect(JSON.parse(localStorage.getItem('user'))).toEqual(next.user);
});

test.each([false, undefined, 'true'])('an editable update cannot grant history access to approval value %s', (approval) => {
  const next = updateOwnAccount(authenticated(approval), { canViewActivityHistory: true });
  expect(next.user.canViewActivityHistory).not.toBe(true);
  expect(JSON.parse(localStorage.getItem('user')).canViewActivityHistory).not.toBe(true);
  expect(next.user.profile.firstName).toBe('After');
});

test('an editable history flag cannot replace the existing server approval', () => {
  const next = updateOwnAccount(authenticated(true), { canViewActivityHistory: false });
  expect(next.user.canViewActivityHistory).toBe(true);
  expect(JSON.parse(localStorage.getItem('user')).canViewActivityHistory).toBe(true);
});

test('updating another account leaves the authenticated account and saved login unchanged', () => {
  const current = authenticated(true);
  const saved = localStorage.getItem('user');
  const next = updateOwnAccount(current, { _id: 'fixture-other-user', canViewActivityHistory: false });
  expect(next).toBe(current);
  expect(localStorage.getItem('user')).toBe(saved);
});

test('an account update does not establish a missing authenticated session', () => {
  const current = { user: null, token: null, isLoading: false, error: null };
  const next = updateOwnAccount(current, { canViewActivityHistory: true });
  expect(next.user).toBeNull();
  expect(localStorage.getItem('user')).toBeNull();
});
