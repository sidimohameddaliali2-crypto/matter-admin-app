import React from 'react';
import { installActivityCapture } from './utils/activityCapture';
import ReactDOM from 'react-dom/client';
import './index.css';
import EntryApp, { isPublicPath } from './EntryApp';

// Public links need no staff activity queue or browser-storage initialization.
if (!isPublicPath(window.location.pathname)) installActivityCapture();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <EntryApp />
  </React.StrictMode>
);

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(registration => {
        console.log('Service Worker registered successfully:', registration.scope);

        // Reload the page automatically when the new SW takes control
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.location.reload();
        });

        // Ask a waiting SW to activate immediately
        const activateUpdate = () => {
          if (registration.waiting) {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        };

        // Periodically check for updates
        setInterval(() => {
          registration.update();
        }, 60000); // every minute

        // Handle new SW install and trigger immediate activation
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New SW is ready, activate it and reload via controllerchange
              activateUpdate();
            }
          });
        });

        // If there's already a waiting SW (rare), activate it now
        if (registration.waiting) {
          activateUpdate();
        }
      })
      .catch(error => {
        console.error('Service Worker registration failed:', error);
      });
  });
}
