import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Layout from './Layout';

let mockPathname = '/customer-service/chats';
const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
jest.mock('react-router-dom', () => ({
  Link: ({ to, children, onClick, reloadDocument, ...props }) => <a href={to} data-reload={reloadDocument || undefined} {...props} onClick={event => { event.preventDefault(); onClick?.(event); mockNavigate(to); }}>{children}</a>,
  useLocation: () => ({ pathname: mockPathname }),
  useMatch: pattern => (mockPathname === pattern || mockPathname === pattern + '/') ? {} : null,
  useNavigate: () => mockNavigate,
}), { virtual: true });
jest.mock('react-redux', () => ({
  useDispatch: () => mockDispatch,
  useSelector: select => select({ auth: { user: { role: 'super_admin', profile: { firstName: 'QA' } } } }),
}));
jest.mock('../store/slices/authSlice', () => ({ logout: () => ({ type: 'auth/logout' }) }));
jest.mock('./users/UserAvatar', () => () => <span>QA</span>);

global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, desktop, listeners;
// jsdom has no top layer. Assert the component calls the native lifecycle;
// keyboard containment and focus restoration are checked in a real browser.
const showModal = jest.fn(function () { this.setAttribute('open', ''); });
const close = jest.fn(function () { this.removeAttribute('open'); });
// ReactDOM's renderer needs act; this does not use Testing Library's wrapped render.
// eslint-disable-next-line testing-library/no-unnecessary-act
const mountLayout = async () => act(async () => root.render(<Layout><button>Inbox content</button></Layout>));
const openMenu = async () => act(async () => container.querySelector('[aria-controls="mobile-navigation"]').click());
const dialog = () => container.querySelector('dialog');

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
});
beforeEach(() => {
  jest.clearAllMocks();
  showModal.mockImplementation(function () { this.setAttribute('open', ''); });
  close.mockImplementation(function () { this.removeAttribute('open'); });
  mockPathname = '/customer-service/chats';
  document.title = 'Matter App';
  listeners = new Set();
  desktop = { matches: false, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) };
  window.matchMedia = jest.fn(() => desktop);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('opens natively, labels the drawer, and synchronizes Escape dismissal with its trigger', async () => {
  await mountLayout();
  await openMenu();
  expect(showModal).toHaveBeenCalledTimes(1);
  expect(dialog().open).toBe(true);
  expect(dialog().getAttribute('aria-label')).toBe('Main navigation');
  expect(dialog().querySelector('[aria-label="Close menu"]')).not.toBeNull();
  expect(container.querySelector('[aria-controls="mobile-navigation"]').getAttribute('aria-expanded')).toBe('true');
  await act(async () => dialog().dispatchEvent(new Event('cancel', { bubbles: true })));
  expect(close).toHaveBeenCalledTimes(1);
  expect(dialog().open).toBe(false);
  expect(container.querySelector('[aria-controls="mobile-navigation"]').getAttribute('aria-expanded')).toBe('false');
  await openMenu();
  expect(showModal).toHaveBeenCalledTimes(2);
});

test('closes on backdrop and close button, while clicks inside the drawer keep it open', async () => {
  await mountLayout(); await openMenu();
  await act(async () => dialog().querySelector('img').click());
  expect(dialog().open).toBe(true);
  await act(async () => dialog().click());
  expect(dialog().open).toBe(false);
  await openMenu();
  await act(async () => dialog().querySelector('[aria-label="Close menu"]').click());
  expect(dialog().open).toBe(false);
});

test('navigation and desktop resizing close the modal so it cannot leave the app blocked', async () => {
  await mountLayout(); await openMenu();
  await act(async () => dialog().querySelector('a[href="/reports"]').click());
  expect(mockNavigate).toHaveBeenCalledWith('/reports');
  expect(dialog().open).toBe(false);
  await openMenu();
  await act(async () => { desktop.matches = true; listeners.forEach(listener => listener()); });
  expect(dialog().open).toBe(false);
  await openMenu();
  mockPathname = '/reports'; await mountLayout();
  expect(dialog().open).toBe(false);
});

test('inbox has a skip target and descriptive heading/title without retaining its title on another page', async () => {
  await mountLayout();
  expect(document.title).toBe('Customer service inbox · Matter');
  expect(container.querySelector('h1').textContent).toBe('Inbox');
  const skip = container.querySelector('.mo-skip-link');
  const target = container.querySelector(skip.getAttribute('href'));
  expect(skip.textContent).toBe('Skip to inbox');
  expect(target.tagName).toBe('MAIN');
  expect(target.tabIndex).toBe(-1);
  mockPathname = '/reports'; await mountLayout();
  expect(document.title).toBe('Matter App');
  expect(container.querySelector('h1')).toBeNull();
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('Driver Reports is a separate item and preserves the native unload boundary', async () => {
  mockPathname = '/reports';
  await mountLayout();
  await openMenu();
  expect(dialog().querySelector('a[href="/driver-reports"]').getAttribute('data-reload')).toBe('true');
  expect(dialog().querySelector('a[href="/reports"]').getAttribute('aria-current')).toBe('page');
  expect(dialog().querySelector('a[href="/reports"]').hasAttribute('data-reload')).toBe(false);

  mockPathname = '/driver-reports/';
  await mountLayout();
  await openMenu();
  expect(dialog().querySelector('a[href="/reports"]').getAttribute('data-reload')).toBe('true');
  expect(dialog().querySelector('a[href="/driver-reports"]').getAttribute('aria-current')).toBe('page');
});
