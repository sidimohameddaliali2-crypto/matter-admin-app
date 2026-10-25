import React, { useEffect, useState } from 'react';
import api from '../../utils/api';
import { BUSINESS_TZ_OFFSET_MINUTES } from '../../utils/businessTime';

const labels = {
  inside_window: 'Photo within tracker visit',
  outside_window: 'Review: photo outside tracker visit',
  pending_exit: 'Waiting for tracker departure',
  incomplete_events: 'Unverified: missing or conflicting tracker events',
  awaiting_events: 'Waiting for tracker entry/exit events',
  missing_photo_time: 'Unverified: camera capture time unavailable',
  uploaded_photo: 'Review: uploaded photo capture time unknown',
  missing_pin: 'Unverified: customer pin missing',
  no_tracker: 'Unverified: driver has no assigned tracker',
  tracker_error: 'Unverified: Truckoom unavailable',
  gps_visit_observed: 'Photo time matches sampled GPS visit (estimated)',
  gps_window_review: 'Review: photo outside sampled GPS visit (estimated)',
};

export function trackerTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return new Date(Date.parse(value) + BUSINESS_TZ_OFFSET_MINUTES * 60000)
    .toISOString().replace('T', ' ').slice(0, 19);
}

export default function TrackerVisitCard({ delivery }) {
  const [latest, setLatest] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setLatest(null);
    if (!delivery?._id) return undefined;
    const refresh = async () => {
      try {
        const res = await api.get(`/deliveries/${delivery._id}`);
        if (!cancelled) setLatest(res.data?.data?.delivery || null);
      } catch { /* Keep the last known result if offline. */ }
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [delivery?._id]);

  const current = latest || delivery;
  if (!current || (current.type && current.type !== 'Delivery')) return null;
  const visit = current.trackerVisit || {};
  const proof = current.proof || {};
  const style = visit.needsReview ? 'border-red-200 bg-red-50 text-red-900'
    : visit.status === 'inside_window' ? 'border-green-200 bg-green-50 text-green-900'
      : 'border-gray-200 bg-gray-50 text-gray-700';
  return (
    <section aria-label="Tracker visit verification" className={`rounded-lg border p-3 text-xs ${style}`}>
      <p className="font-semibold">Customer radius: {visit.radiusMetres || 50} m</p>
      <p className="mt-1 font-medium">{labels[visit.status] || 'Waiting for tracker verification'}</p>
      <dl className="mt-2 space-y-1">
        <div><dt className="inline font-medium">Tracker arrival: </dt><dd className="inline">{trackerTime(visit.arrivedAt)}</dd></div>
        <div><dt className="inline font-medium">Photo captured: </dt><dd className="inline">{trackerTime(proof.photoCapturedAt)}</dd></div>
        <div><dt className="inline font-medium">Tracker departure: </dt><dd className="inline">{trackerTime(visit.departedAt)}</dd></div>
      </dl>
      <p className="mt-2 opacity-80">Dubai time · Camera time reported by driver device. Tracker times are approximate.</p>
      {visit.evidenceSource === 'truckoom_gps_samples' && <p className="mt-1 font-medium">Visit times estimated from recorded vehicle GPS. No Truckoom geofence alert was received.</p>}
      {visit.checkedAt && <p className="mt-1 opacity-70">Checked: {trackerTime(visit.checkedAt)}</p>}
    </section>
  );
}
