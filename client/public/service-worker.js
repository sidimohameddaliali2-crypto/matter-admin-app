/* eslint-disable no-restricted-globals */

const CACHE_NAME = 'delivery-tracker-v2';
const OFFLINE_URL = '/driver-mobile';

// Assets to cache on install
const STATIC_ASSETS = [
  // Intentionally exclude '/' (index.html) to avoid sticky old shell
  '/driver-mobile',
  '/static/css/main.css',
  '/manifest.json',
  '/images/delivery-bag.png',
  '/images/location-icon.png'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching static assets');
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.error('[Service Worker] Cache addAll error:', err);
      });
    }).then(() => {
      console.log('[Service Worker] Skip waiting');
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[Service Worker] Claiming clients');
      return self.clients.claim();
    })
  );
});

// Fetch event - Prefer network for navigations; cache-first for static
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Production kitchen inputs and reconciliation must fail when offline.
  // A previously cached successful response cannot establish current Matter data.
  if (url.pathname === '/api/matter/subscriptions/kitchen-inputs'
    || url.pathname === '/api/matter/subscriptions/delivery-on-date'
    || /^\/api\/matter\/subscriptions\/[^/]+\/delivery-comparison$/.test(url.pathname)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Handle API requests - Network first with offline queue
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clone response and cache successful GET API responses only (Cache API limitation)
          if (response.ok && request.method === 'GET') {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(async () => {
          // If offline, try to return cached API response (only for GET requests)
          if (request.method === 'GET') {
            const cachedResponse = await caches.match(request);
            if (cachedResponse) {
              console.log('[Service Worker] Serving cached API response for:', request.url);
              return cachedResponse;
            }
          }
          
          // Return offline response
          return new Response(
            JSON.stringify({ 
              success: false, 
              offline: true,
              message: 'You are offline. Changes will be synced when online.' 
            }),
            { 
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        })
    );
    return;
  }

  // Handle page navigation - Network first (prevents stale index.html)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) return cachedResponse;
          return caches.match(OFFLINE_URL);
        })
    );
    return;
  }

  // Handle static assets - Cache first
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((response) => {
        // Cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return response;
      });
    })
  );
});

// Background sync event - sync offline data when online
self.addEventListener('sync', (event) => {
  console.log('[Service Worker] Background sync:', event.tag);
  
  if (event.tag === 'sync-deliveries') {
    event.waitUntil(syncOfflineData());
  }
});

// Sync offline data
async function syncOfflineData() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    
    // Find POST/PUT/PATCH requests that were queued
    const offlineRequests = requests.filter(req => 
      ['POST', 'PUT', 'PATCH'].includes(req.method)
    );

    console.log('[Service Worker] Syncing', offlineRequests.length, 'offline requests');

    for (const request of offlineRequests) {
      try {
        await fetch(request.clone());
        await cache.delete(request);
        console.log('[Service Worker] Synced request:', request.url);
      } catch (error) {
        console.error('[Service Worker] Failed to sync request:', error);
      }
    }

    // Notify clients that sync is complete
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_COMPLETE' });
    });
  } catch (error) {
    console.error('[Service Worker] Sync error:', error);
  }
}

// Message event - handle messages from clients
self.addEventListener('message', (event) => {
  console.log('[Service Worker] Message received:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.delete(CACHE_NAME).then(() => {
        console.log('[Service Worker] Cache cleared');
        return self.registration.update();
      })
    );
  }
});
