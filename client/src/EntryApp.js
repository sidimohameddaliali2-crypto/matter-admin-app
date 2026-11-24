import React, { lazy, Suspense } from 'react';

const StaffApp = lazy(() => import('./App'));
const PublicMenuApp = lazy(() => import('./pages/PublicMenuApp'));
export const isPublicMenuPath = path => /^\/(?:menu-select|m)\/[^/]+\/?$/.test(path);

export class EntryBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main style={{ padding: 32, textAlign: 'center' }}>
      <h1>Unable to load this page</h1>
      <p>Please check your connection and try again.</p>
      <button onClick={() => window.location.reload()}>Try again</button>
    </main>;
    return this.props.children;
  }
}

export default function EntryApp() {
  // Do not evaluate the staff Redux stores for a customer link: some stores
  // read localStorage while loading and can fail before React renders in Safari.
  const App = isPublicMenuPath(window.location.pathname) ? PublicMenuApp : StaffApp;
  return <EntryBoundary><Suspense fallback={<p role="status" style={{ padding: 32, textAlign: 'center' }}>Loading…</p>}><App /></Suspense></EntryBoundary>;
}
