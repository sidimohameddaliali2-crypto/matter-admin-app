import { load } from '@2gis/mapgl';

export const MAPGL_API_KEY = process.env.REACT_APP_2GIS_API_KEY || '';

// Share in-flight loads so overlapping maps or StrictMode mounts inject one script.
let pendingLoad;
export function loadMapglOnce() {
  if (!pendingLoad) {
    pendingLoad = load().catch(error => {
      pendingLoad = undefined;
      throw error;
    });
  }
  return pendingLoad;
}

// A map destroyed during initialization can reject with no reason inside the SDK.
export function destroyMapSuppressingSdkNoise(map) {
  if (!map) return;
  const onRejection = event => { if (event.reason === undefined) event.preventDefault(); };
  window.addEventListener('unhandledrejection', onRejection);
  setTimeout(() => window.removeEventListener('unhandledrejection', onRejection), 500);
  try { map.destroy(); } catch (_) { /* already gone */ }
}
