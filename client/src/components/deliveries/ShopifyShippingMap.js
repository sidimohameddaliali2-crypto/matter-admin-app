import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { getDeliveryLatLng } from '../../utils/deliveryCoords';
import { MAPGL_API_KEY, loadMapglOnce, destroyMapSuppressingSdkNoise } from '../../utils/mapgl';

function ShippingPin({ lat, lng }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState(MAPGL_API_KEY ? 'loading' : 'unavailable');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;

  useEffect(() => {
    if (!MAPGL_API_KEY) return undefined;
    let cancelled = false;
    let map;
    let marker;
    const unavailable = () => { if (!cancelled) setStatus('unavailable'); };

    loadMapglOnce().then((mapgl) => {
      if (cancelled || !containerRef.current) return;
      if (typeof mapgl.isSupported === 'function' && !mapgl.isSupported()) {
        unavailable();
        return;
      }

      const coordinates = [lng, lat];
      map = new mapgl.Map(containerRef.current, {
        key: MAPGL_API_KEY,
        center: coordinates,
        zoom: 16,
        disableZoomOnScroll: true,
      });
      map.on('styleload', () => { if (!cancelled) setStatus('ready'); });
      map.on('styleloaderror', unavailable);
      marker = new mapgl.Marker(map, { coordinates });
    }).catch(unavailable);

    return () => {
      cancelled = true;
      marker?.destroy();
      destroyMapSuppressingSdkNoise(map);
    };
  }, [lat, lng]);

  return (
    <div className="mt-4">
      {status !== 'unavailable' && (
        <div className="relative h-48 overflow-hidden rounded-lg border border-blue-100 bg-white sm:h-56">
          <div ref={containerRef} className="h-full w-full" role="region" aria-label="Shipping location map" />
          {status === 'loading' && (
            <p role="status" className="pointer-events-none absolute bottom-3 left-3 rounded bg-white px-2 py-1 text-xs text-gray-600">
              Loading map…
            </p>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {status === 'unavailable' && <p role="status" className="text-gray-600">Map preview unavailable.</p>}
        <a href={mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline">
          Open pin in Google Maps <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

export default function ShopifyShippingMap({ address }) {
  const pin = getDeliveryLatLng({ latitude: address.latitude, longitude: address.longitude });
  if (!pin) return <p className="mt-3 text-xs text-gray-600">Shopify has no map pin for this shipping address.</p>;
  return <ShippingPin key={`${pin.lat},${pin.lng}`} lat={pin.lat} lng={pin.lng} />;
}
