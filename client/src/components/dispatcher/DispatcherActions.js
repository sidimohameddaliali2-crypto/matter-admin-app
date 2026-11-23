import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Search } from 'lucide-react';
import api from '../../utils/api';
import { DispatcherDialog } from './DispatcherFilters';
import { driverId, errorMessage, staffName, isFinished, businessToday } from '../../utils/dispatcher';
import { formatBusinessDateInput, formatBusinessTime } from '../../utils/businessTime';
import { dateLabel, Cell } from './DispatcherDelivery';
export function DispatcherAssignment({
  targets,
  deliveries,
  drivers,
  onClose,
  onSaved
}) {
  const [chosen, setChosen] = useState(''),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false);
  const save = async () => {
    if (lock.current || !chosen) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await api.patch('/deliveries/assign-driver', {
        deliveryIds: targets.map(d => d._id),
        driverId: chosen
      });
      if (r.data.success === false) throw new Error(r.data.message);
      onSaved(r.data.message || 'Driver assignment saved.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const matches = drivers.filter(d => (staffName(d) + ' ' + (d.email || '')).toLowerCase().includes(search.trim().toLowerCase()));
  return <DispatcherDialog title={`Assign ${targets.length === 1 ? 'a driver' : targets.length + ' deliveries'}`} onClose={onClose} busy={busy}><p>{targets.map(d => d.customerName).join(' · ')}</p><label className="dp-search"><Search size={18} /><input aria-label="Search assignment drivers" placeholder="Search driver…" value={search} disabled={busy} onChange={e => setSearch(e.target.value)} /></label><p className="dp-help">{matches.length} {matches.length === 1 ? 'matching driver' : 'matching drivers'}</p><div className="dp-driver-choices" role="group" aria-label="Drivers available for assignment">{matches.map(d => <button disabled={busy} key={d._id} aria-pressed={chosen === String(d._id)} onClick={() => setChosen(String(d._id))}><span className="dp-avatar">{staffName(d).slice(0, 2).toUpperCase()}</span><span><strong>{staffName(d)}</strong><small>{deliveries.filter(x => driverId(x.driver) === String(d._id) && !isFinished(x)).length} assigned · {d.profile?.vehicleType || 'Driver'}</small></span>{chosen === String(d._id) && <Check size={20} />}</button>)}</div>{!matches.length && <p>{drivers.length ? 'No drivers match.' : 'No active drivers available.'}</p>}{error && <p className="dp-error" role="alert">{error}</p>}<div className="dp-actions"><button className="primary" disabled={!chosen || busy} onClick={save}>{busy ? 'Saving…' : 'Confirm assignment'}</button></div></DispatcherDialog>;
}
export function DispatcherOrder({
  date,
  drivers,
  onClose,
  onSaved
}) {
  const [driver, setDriver] = useState(''),
    [rows, setRows] = useState([]),
    [revision, setRevision] = useState(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    setRows([]);
    setRevision(null);
    setError('');
    if (!driver) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get('/deliveries/delivery-order', {
      params: {
        driverId: driver,
        date
      }
    }).then(r => {
      if (active) {
        setRows(r.data.data.deliveries);
        setRevision(r.data.data.revision);
      }
    }).catch(e => {
      if (active) setError(errorMessage(e));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [driver, date, refresh]);
  const move = (i, delta) => setRows(previous => {
    const next = [...previous];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    return next;
  });
  const save = async () => {
    if (lock.current || !revision) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.put('/deliveries/delivery-order', {
        driverId: driver,
        date,
        revision,
        deliveryIds: rows.map(d => d._id)
      });
      onSaved('Stop order saved. The driver sees it on refresh.');
    } catch (e) {
      setError(errorMessage(e));
      setRevision(null);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return <DispatcherDialog title="Arrange the run" onClose={onClose} busy={busy}><p className="dp-help">{dateLabel(date + 'T12:00:00Z')} · All assigned stops are included. Move stops to choose the first and last delivery.</p><label className="dp-field">Driver<select value={driver} disabled={busy} onChange={e => setDriver(e.target.value)}><option value="">Choose a driver</option>{drivers.map(d => <option key={d._id} value={d._id}>{staffName(d)}</option>)}</select></label>{loading && <p role="status">Loading delivery order…</p>}<ol className="dp-order-list">{rows.map((d, i) => <li key={d._id}><b>{i + 1}</b><div><strong>{d.customerName}</strong><small>{d.address}</small><small>{formatBusinessTime(d.scheduledTime)} · {d.status}{i === 0 ? ' · First stop' : i === rows.length - 1 ? ' · Last stop' : ''}</small></div><span><button aria-label={`Move stop ${i + 1} up`} disabled={busy || !revision || i === 0} onClick={() => move(i, -1)}><ArrowUp size={17} /></button><button aria-label={`Move stop ${i + 1} down`} disabled={busy || !revision || i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={17} /></button></span></li>)}</ol>{driver && !loading && !rows.length && <p>No deliveries assigned for this date.</p>}{error && <p className="dp-error" role="alert">{error}</p>}<div className="dp-actions"><button disabled={busy || loading || !driver} onClick={() => setRefresh(r => r + 1)}>Reload</button><button className="primary" disabled={busy || loading || !revision || rows.length < 2} onClick={save}>{busy ? 'Saving…' : 'Apply order'}</button></div></DispatcherDialog>;
}
const eventBrands = event => {
  const company = String(event.companyName || '');
  return [
    ...( /\bmatter\b/i.test(company) ? ['matter'] : []),
    ...( /\byellow[\s_-]*block\b/i.test(company) ? ['yellow-block'] : [])
  ];
};
const brandLabel = brand => brand === 'matter' ? 'MATTER' : 'Yellow Block';
const dayBrandClass = events => {
  const brands = new Set(events.flatMap(eventBrands));
  return brands.has('matter') && brands.has('yellow-block') ? 'dp-day-both'
    : brands.has('matter') ? 'dp-day-matter'
    : brands.has('yellow-block') ? 'dp-day-yellow-block'
    : events.length ? 'dp-day-other' : '';
};
const EventBrandLabels = ({ event }) => {
  const brands = eventBrands(event);
  return <span className="dp-event-brands">{brands.length ? brands.map(brand =>
    <span key={brand} className={`dp-event-brand dp-event-brand-${brand}`}>{brandLabel(brand)}</span>
  ) : <span className="dp-event-brand">{event.companyName || 'Company not recorded'}</span>}</span>;
};
export function DispatcherEvents({
  onClose
}) {
  const [events, setEvents] = useState([]),
    [date, setDate] = useState(businessToday),
    [month, setMonth] = useState(() => businessToday().slice(0, 7)),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [event, setEvent] = useState(null),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get('/events').then(r => {
      if (active) {
        setEvents(r.data.events || []);
        setError('');
      }
    }).catch(e => {
      if (active) setError(errorMessage(e));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refresh]);
  const [year, m] = month.split('-').map(Number),
    first = new Date(Date.UTC(year, m - 1, 1)),
    days = new Date(Date.UTC(year, m, 0)).getUTCDate(),
    offset = (first.getUTCDay() + 6) % 7;
  const shift = delta => setMonth(new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7));
  const forDay = events.filter(e => formatBusinessDateInput(e.eventDate) === date);
  return <DispatcherDialog title={event ? event.eventName || event.name || 'Event details' : 'Events calendar'} onClose={onClose}>{loading && <p role="status">Loading events…</p>}{error && <p className="dp-error" role="alert">{error} <button onClick={() => setRefresh(r => r + 1)}>Retry</button></p>}{event ? <><div className="dp-detail-grid"><Cell label="Company" value={event.companyName} /><Cell label="Date" value={dateLabel(event.eventDate)} /><Cell label="Arrival time" value={event.arrivalTime} /><Cell label="Status" value={event.status} /><Cell label="Emirate" value={event.emirate} /></div><section className="dp-detail-section"><h3>Venue</h3><p>{event.venue?.address || event.venue?.area || 'Not recorded'}</p></section><section className="dp-detail-section"><h3>Contact</h3><p>{event.pointOfContact?.name || 'Not recorded'}</p>{event.pointOfContact?.phone && <a className="dp-call" href={`tel:${event.pointOfContact.phone}`}>{event.pointOfContact.phone}</a>}</section><section className="dp-detail-section"><h3>Instructions</h3><p>{event.notes || event.logistics?.specialRequests || 'No instructions recorded'}</p>{event.logistics?.food?.map((food, i) => <p key={i}>{food.name} · {food.quantity}</p>)}</section><button onClick={() => setEvent(null)}>Back to calendar</button></> : <><div className="dp-calendar-heading"><button aria-label="Previous month" onClick={() => shift(-1)}>←</button><strong>{first.toLocaleDateString('en-GB', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC'
          })}</strong><button aria-label="Next month" onClick={() => shift(1)}>→</button></div><div className="dp-calendar">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => <span key={i}>{day}</span>)}{Array.from({
          length: offset
        }, (_, i) => <span key={'empty' + i} />)}{Array.from({
          length: days
        }, (_, i) => {
          const key = `${month}-${String(i + 1).padStart(2, '0')}`;
          const dayEvents = events.filter(e => formatBusinessDateInput(e.eventDate) === key);
          const brands = [...new Set(dayEvents.flatMap(eventBrands))].map(brandLabel);
          const description = dayEvents.length ? ` · ${brands.join(' and ') || 'Other company'} · ${dayEvents.length} ${dayEvents.length === 1 ? 'event' : 'events'}` : '';
          return <button aria-label={dateLabel(key + 'T12:00:00Z') + description} aria-pressed={date === key} key={key} className={dayBrandClass(dayEvents)} onClick={() => setDate(key)}>{i + 1}</button>;
        })}</div><div className="dp-calendar-legend" aria-label="Calendar event colors"><span><i className="dp-legend-matter" aria-hidden="true"/>MATTER</span><span><i className="dp-legend-yellow-block" aria-hidden="true"/>Yellow Block</span><span><i className="dp-legend-both" aria-hidden="true"/>Both</span></div><h3>{dateLabel(date + 'T12:00:00Z')}</h3>{forDay.map(e => <button className="dp-event" key={e._id} onClick={() => setEvent(e)}><EventBrandLabels event={e} /><strong>{e.eventName || e.name || 'Event'}</strong><small>{e.arrivalTime} · {e.venue?.area || e.emirate} · {e.status}</small></button>)}{!loading && !forDay.length && <p className="dp-empty">No events on this day.</p>}<button onClick={() => {
        setMonth(businessToday().slice(0, 7));
        setDate(businessToday());
      }}>Today</button></>}</DispatcherDialog>;
}
