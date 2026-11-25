import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { isKitchenAppPath } from '../utils/yellowblockKitchenPaths';
import { isDriverAppPath } from '../utils/yellowblockDriverPaths';

export default function YellowblockMobileMetadata() {
  const { pathname } = useLocation();
  const app = isKitchenAppPath(pathname) ? 'kitchen' : isDriverAppPath(pathname) ? 'driver' : null;

  useLayoutEffect(() => {
    if (!app) return undefined;

    const title = document.title;
    const attributes = [
      ['link[rel="manifest"]', 'href', `/yellowblock-${app}.webmanifest`],
      ['link[rel="apple-touch-icon"]', 'href', '/images/yellowblock-kitchen-180.png'],
      ['meta[name="theme-color"]', 'content', '#fbeae2'],
      ['meta[name="viewport"]', 'content', 'width=device-width, initial-scale=1.0, viewport-fit=cover'],
    ];
    const updates = attributes.flatMap(([selector, attribute, value]) => {
      const element = document.querySelector(selector);
      if (!element) return [];
      const original = element.getAttribute(attribute);
      element.setAttribute(attribute, value);
      return [[element, attribute, original]];
    });
    document.title = app === 'kitchen' ? 'Yellow Block Kitchen' : 'Yellow Block Driver';

    return () => {
      updates.forEach(([element, attribute, original]) => element.setAttribute(attribute, original));
      document.title = title;
    };
  }, [app]);

  return null;
}
