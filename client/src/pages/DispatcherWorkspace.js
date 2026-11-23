import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarDays, Check, Clock, History, LayoutDashboard, ListOrdered, LogOut, MapPin, Package, Plus, RefreshCw, Search, Truck, Users, X } from 'lucide-react';
import api from '../utils/api';
import { logout } from '../store/slices/authSlice';
import { useSocket } from '../contexts/SocketContext';
import { businessToday, shiftDay, emptyFilters, emirate, driverId, staffName, isFinished, filterDispatchDeliveries, loadDispatchDay, errorMessage } from '../utils/dispatcher';
import { formatBusinessTime } from '../utils/businessTime';
import DispatcherFilters, { DispatcherDialog } from '../components/dispatcher/DispatcherFilters';
import { DeliveryDetails, DispatcherDeliveryForm, dateLabel, timestamp, Cell } from '../components/dispatcher/DispatcherDelivery';
import { DispatcherAssignment, DispatcherOrder, DispatcherEvents } from '../components/dispatcher/DispatcherActions';
import DispatcherNewCustomers from '../components/dispatcher/DispatcherNewCustomers';
import DispatcherHandover from '../components/dispatcher/DispatcherHandover';
import '../styles/dispatcherWorkspace.css';
const navigation = [['dispatch', 'Dispatch', LayoutDashboard], ['drivers', 'Drivers', Users], ['handover', 'Handover', Truck], ['history', 'History', History]];
const labelStatus = d => !d.driver && d.status === 'pending' ? 'Unassigned' : String(d.status || 'pending').replaceAll('_', ' ');
export default function DispatcherWorkspace() {
  const {
      user
    } = useSelector(s => s.auth),
    dispatch = useDispatch(),
    navigate = useNavigate(),
    {
      socket
    } = useSocket();
  const [view, setView] = useState('dispatch'),
    [date, setDate] = useState(() => shiftDay(businessToday(), 1)),
    [deliveries, setDeliveries] = useState([]),
    [drivers, setDrivers] = useState([]),
    [loading, setLoading] = useState(true),
    [driverLoading, setDriverLoading] = useState(true),
    [error, setError] = useState(''),
    [driverError, setDriverError] = useState('');
  const [search, setSearch] = useState(''),
    [filters, setFilters] = useState(emptyFilters),
    [collections, setCollections] = useState(false),
    [unassigned, setUnassigned] = useState(false),
    [selected, setSelected] = useState([]),
    [page, setPage] = useState(0),
    [modal, setModal] = useState(null),
    [detail, setDetail] = useState(null),
    [detailLoading, setDetailLoading] = useState(false),
    [formError, setFormError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [customDate, setCustomDate] = useState(date),
    [driverSearch, setDriverSearch] = useState('');
  const [receipts, setReceipts] = useState([]),
    [historyLoading, setHistoryLoading] = useState(false),
    [historyError, setHistoryError] = useState(''),
    [historySearch, setHistorySearch] = useState(''),
    [historyStatus, setHistoryStatus] = useState('all'),
    [historyVersion, setHistoryVersion] = useState(0),
    [historyTruncated, setHistoryTruncated] = useState(false);
  const fetchId = useRef(0),
    detailId = useRef(0),
    writeLock = useRef(false);
  const canBags = user?.permissions?.bags !== false;
  const load = useCallback(async () => {
    const n = ++fetchId.current;
    setLoading(true);
    setError('');
    try {
      const data = await loadDispatchDay(api, date);
      if (n === fetchId.current) setDeliveries(data);
    } catch (e) {
      if (n === fetchId.current) {
        setError(errorMessage(e));
        setDeliveries([]);
      }
    } finally {
      if (n === fetchId.current) setLoading(false);
    }
  }, [date]);
  const loadDrivers = useCallback(async () => {
    setDriverLoading(true);
    setDriverError('');
    try {
      const r = await api.get('/users/drivers');
      const raw = Array.isArray(r.data) ? r.data : r.data.data || r.data.drivers;
      const data = Array.isArray(raw) ? raw : raw?.drivers;
      if (!Array.isArray(data)) throw new Error('Could not read the driver list. Please retry.');
      setDrivers(data.filter(d => d.isActive !== false).sort((a, b) => staffName(a).localeCompare(staffName(b))));
    } catch (e) {
      setDriverError(errorMessage(e));
    } finally {
      setDriverLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
    return () => {
      fetchId.current++;
    };
  }, [load]);
  useEffect(() => {
    loadDrivers();
  }, [loadDrivers]);
  useEffect(() => {
    if (!socket) return;
    let timer;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        load();
        setHistoryVersion(v => v + 1);
      }, 350);
    };
    for (const event of ['delivery:created', 'delivery:updated', 'delivery:statusUpdate', 'deliveries:deleted', 'bag:updated']) socket.on(event, refresh);
    return () => {
      clearTimeout(timer);
      for (const event of ['delivery:created', 'delivery:updated', 'delivery:statusUpdate', 'deliveries:deleted', 'bag:updated']) socket.off(event, refresh);
    };
  }, [socket, load]);
  useEffect(() => {
    if (view !== 'history') return;
    let active = true;
    setHistoryLoading(true);
    setHistoryError('');
    api.get('/dispatcher-handovers').then(r => {
      if (active) {
        setReceipts(r.data.data.receipts);
        setHistoryTruncated(r.data.data.truncated);
      }
    }).catch(e => {
      if (active) setHistoryError(errorMessage(e));
    }).finally(() => {
      if (active) setHistoryLoading(false);
    });
    return () => {
      active = false;
    };
  }, [view, historyVersion]);
  useEffect(() => {
    setPage(0);
  }, [search, filters, collections, unassigned, date]);
  useEffect(() => {
    setSelected(current => current.filter(id => deliveries.some(d => d._id === id && !isFinished(d))));
  }, [deliveries]);
  const rows = useMemo(() => filterDispatchDeliveries(deliveries, {
    date,
    search,
    filters,
    collections,
    unassigned
  }), [deliveries, date, search, filters, collections, unassigned]);
  useEffect(() => {
    setPage(current => Math.min(current, Math.max(0, Math.ceil(rows.length / 30) - 1)));
  }, [rows.length]);
  const visible = rows.slice(page * 30, page * 30 + 30),
    chosen = deliveries.filter(d => selected.includes(d._id) && !isFinished(d));
  const zones = useMemo(() => [...new Set(deliveries.map(d => d.zone || d.addressDetails?.area || 'No zone'))].sort(), [deliveries]),
    emirates = useMemo(() => [...new Set(deliveries.map(emirate).filter(Boolean))].sort(), [deliveries]);
  const filterCount = Object.values(filters).reduce((sum, values) => sum + values.length, 0);
  const close = () => {
    detailId.current++;
    setModal(null);
    setDetail(null);
    setFormError('');
  };
  const changeDate = value => {
    if (!value) return;
    detailId.current++;
    fetchId.current++;
    setDate(value);
    setSelected([]);
    setDeliveries([]);
    setModal(null);
    setPage(0);
  };
  const openDetail = async d => {
    const n = ++detailId.current;
    setModal({
      type: 'detail',
      delivery: d
    });
    setDetail(null);
    setDetailLoading(true);
    setFormError('');
    try {
      const r = await api.get(`/deliveries/${d._id}`);
      if (n === detailId.current) setDetail(r.data.data?.delivery || r.data.data || r.data.delivery);
    } catch (e) {
      if (n === detailId.current) setFormError(errorMessage(e));
    } finally {
      if (n === detailId.current) setDetailLoading(false);
    }
  };
  const saved = message => {
    close();
    setSelected([]);
    setNotice(message);
    load();
  };
  const unassign = async () => {
    if (writeLock.current) return;
    writeLock.current = true;
    setBusy(true);
    setFormError('');
    try {
      const r = await api.patch('/deliveries/unassign-driver', {
        deliveryIds: modal.targets.map(d => d._id)
      });
      if (r.data.success === false) throw new Error(r.data.message);
      saved(r.data.message || 'Driver unassigned.');
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
      writeLock.current = false;
    }
  };
  const openAssign = targets => {
    setFormError('');
    setModal({
      type: 'assign',
      targets
    });
  };
  const openUnassign = targets => {
    setFormError('');
    setModal({
      type: 'unassign',
      targets: targets.filter(d => d.driver && !isFinished(d))
    });
  };
  const toggle = id => setSelected(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const selectable = rows.filter(d => !isFinished(d));
  const tab = key => {
    close();
    setView(key);
    setSelected([]);
    window.scrollTo?.(0, 0);
  };
  const receiptRows = receipts.filter(r => (historyStatus === 'all' || r.status === historyStatus) && `${r.id} ${r.dispatcherName} ${r.driverName} ${r.bags.map(b => b.bagId).join(' ')}`.toLowerCase().includes(historySearch.trim().toLowerCase()));
  const nav = navigation.filter(([key]) => canBags || !['handover', 'history'].includes(key));
  const pill = d => <span className={`dp-pill ${d.status}`}>{labelStatus(d)}</span>;
  const deliveryCard = d => <article key={d._id} className="dp-delivery-card"><div className="dp-card-head"><input aria-label={`Select ${d.customerName}`} type="checkbox" checked={selected.includes(d._id)} disabled={loading || isFinished(d)} onChange={() => toggle(d._id)} /><strong>{d.customerName}</strong>{pill(d)}</div><div className="dp-card-info"><span><MapPin size={15} />{d.zone || d.addressDetails?.area || 'No zone'}</span><span><Clock size={15} />{formatBusinessTime(d.scheduledTime)}</span></div>{(d.combinedSunday || d.sundayOnlyCarriedOver) && <small className="dp-weekend">{d.combinedSunday ? 'Sunday meals included' : 'Sunday meal carried to Saturday'}</small>}<div className="dp-card-bottom"><span>{d.customerId || 'No customer ID'} · {d.driver ? staffName(typeof d.driver === 'object' ? d.driver : drivers.find(x => String(x._id) === driverId(d.driver))) : 'Unassigned'}</span><button onClick={() => openDetail(d)}>Details <ArrowRight size={16} /></button></div></article>;
  return <div className="dp-workspace"><aside className="dp-sidebar"><a href="/dispatcher" className="dp-brand" onClick={e => {
        e.preventDefault();
        tab('dispatch');
      }}>MATTER<sup>®</sup></a><div className="dp-sideapp"><Truck /><div><strong>Dispatcher</strong><small>Delivery operations</small></div></div><p className="dp-eyebrow">YOUR WORKSPACE</p><nav aria-label="Dispatcher navigation">{nav.map(([key, label, Icon]) => <button key={key} aria-current={view === key ? 'page' : undefined} className={view === key ? 'active' : ''} onClick={() => tab(key)}><Icon size={20} /><span>{label}</span></button>)}</nav><footer><strong>{staffName(user)}</strong><small>MATTER / Dubai</small><button onClick={() => {
          dispatch(logout());
          navigate('/login', {
            replace: true
          });
        }}><LogOut size={17} />Sign out</button></footer></aside><header className="dp-mobile-header"><span className="dp-brand">MATTER<sup>®</sup></span><span>DISPATCHER</span><button aria-label="Sign out" onClick={() => {
        dispatch(logout());
        navigate('/login', {
          replace: true
        });
      }}><LogOut size={19} /></button></header><header className="dp-topbar"><span>Operations / <strong>Dispatcher</strong></span><span>Dubai · UTC+4</span></header><main className="dp-main">
 {notice && <div className="dp-notice" role="status"><Check size={18} /><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={17} /></button></div>}
 {driverError && <p className="dp-error" role="alert">Drivers: {driverError} <button onClick={loadDrivers}>Retry drivers</button></p>}
 {view === 'dispatch' && <><div className="dp-heading"><div><p className="dp-eyebrow">DISPATCHER / DUBAI</p><h1>Your dispatch,<br className="dp-mobile-only" /> in hand.</h1><p>Deliveries, collections, and bag handovers.</p></div><button className="dp-new" aria-label="New delivery" onClick={() => setModal({
            type: 'new'
          })}><Plus size={20} /><span>New delivery</span></button></div>{canBags && <button className="dp-handover-cta" onClick={() => tab('handover')}><span><Truck size={25} /></span><div><strong>Bag handover</strong><small>Your name. Every bag. On record.</small></div><ArrowRight size={22} /></button>}<div className="dp-toolbar"><button aria-pressed={collections} onClick={() => setCollections(v => !v)}><Package size={17} />Collections</button><button onClick={() => setModal({
            type: 'events'
          })}><CalendarDays size={17} />Events</button><button aria-label="Refresh deliveries" disabled={loading} onClick={() => { load(); loadDrivers(); }}><RefreshCw size={17} /></button></div><section className="dp-panel dp-board"><div className="dp-panel-title"><div><p className="dp-eyebrow">YOUR DELIVERY BOARD</p><h2>Deliveries <span>{deliveries.length}</span></h2></div><button className="dp-date" onClick={() => {
              setCustomDate(date);
              setModal({
                type: 'date'
              });
            }}><CalendarDays size={17} />{date === shiftDay(businessToday(), 1) ? 'Tomorrow' : date === businessToday() ? 'Today' : dateLabel(date + 'T12:00:00Z')}⌄</button></div><div className="dp-board-filters"><label className="dp-search"><Search size={18} /><input aria-label="Search deliveries" placeholder="Customer, ID, address or zone…" value={search} onChange={e => setSearch(e.target.value)} /></label><button className="dp-filter-trigger" onClick={() => setModal({
              type: 'filters'
            })}><span><strong>Filters</strong><small>Zone · Driver · Hours · Emirate</small></span><b>{filterCount ? `${filterCount} selected` : 'All'} ⌄</b></button></div><div className="dp-board-actions"><button aria-pressed={unassigned} onClick={() => setUnassigned(v => !v)}>Unassigned</button><button onClick={() => setModal({
              type: 'order'
            })} disabled={driverLoading}><ListOrdered size={17} />Arrange order</button></div><DispatcherNewCustomers /><div className="dp-select-all"><button aria-label="Select all deliveries" disabled={loading || !selectable.length} onClick={() => setSelected(selectable.map(d => d._id))}>Select all deliveries <b>{selectable.length}</b></button><small>All matching deliveries across every page</small></div>{chosen.length > 0 && <div className="dp-selection"><strong>{chosen.length} selected</strong><button className="primary" disabled={loading || driverLoading} onClick={() => openAssign(chosen)}>Assign / reassign</button><button disabled={loading || !chosen.some(d => d.driver)} onClick={() => openUnassign(chosen)}>Unassign</button><button onClick={() => setSelected([])}>Clear</button></div>}{error && <p className="dp-error" role="alert">{error} <button onClick={load}>Retry</button></p>}{loading && <p className="dp-empty" role="status">Loading deliveries…</p>}{!loading && <><div className="dp-table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all filtered deliveries" checked={selectable.length > 0 && selectable.every(d => selected.includes(d._id))} onChange={e => setSelected(e.target.checked ? selectable.map(d => d._id) : [])} /></th><th>Customer / delivery</th><th>Area & time</th><th>Driver</th><th>Status</th><th /></tr></thead><tbody>{visible.map(d => <tr key={d._id}><td><input type="checkbox" aria-label={`Select ${d.customerName}`} disabled={isFinished(d)} checked={selected.includes(d._id)} onChange={() => toggle(d._id)} /></td><td><strong>{d.customerName}</strong><small>{d.customerId} · {d.type}</small>{d.combinedSunday && <small>Sunday meals included</small>}{d.sundayOnlyCarriedOver && <small>Sunday meal carried to Saturday</small>}</td><td>{d.zone || 'No zone'}<small>{formatBusinessTime(d.scheduledTime)}</small></td><td>{d.driver ? staffName(typeof d.driver === 'object' ? d.driver : drivers.find(x => String(x._id) === driverId(d.driver))) : 'Unassigned'}</td><td>{pill(d)}</td><td><button aria-label={`Open ${d.customerName}`} onClick={() => openDetail(d)}><ArrowRight size={17} /></button></td></tr>)}</tbody></table></div><div className="dp-delivery-cards">{visible.map(deliveryCard)}</div>{!rows.length && !error && <p className="dp-empty">No deliveries match this date and these filters.</p>}</>}<footer className="dp-board-footer"><small>{rows.length} matching deliveries · Dubai time</small>{rows.length > 30 && <div><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button><span>{page + 1} / {Math.ceil(rows.length / 30)}</span><button disabled={(page + 1) * 30 >= rows.length} onClick={() => setPage(p => p + 1)}>Next</button></div>}</footer></section></>}
 {view === 'drivers' && <><div className="dp-heading"><div><p className="dp-eyebrow">PREPARE THE TEAM</p><h1>Drivers & their day.</h1><p>{dateLabel(date + 'T12:00:00Z')} · selected dispatch schedule</p></div></div><label className="dp-search"><Search size={18} /><input aria-label="Search drivers" placeholder="Search drivers…" value={driverSearch} onChange={e => setDriverSearch(e.target.value)} /></label><div className="dp-driver-grid">{drivers.filter(d => staffName(d).toLowerCase().includes(driverSearch.toLowerCase())).map(d => <article className="dp-panel" key={d._id}><span className="dp-avatar">{staffName(d).slice(0, 2).toUpperCase()}</span><h3>{staffName(d)}</h3><p className="dp-help">{d.profile?.vehicleType || 'Driver'}</p><div className="dp-summary-row"><span>Assigned deliveries</span><strong>{deliveries.filter(x => driverId(x.driver) === String(d._id)).length}</strong></div>{canBags && <button className="primary dp-full" onClick={() => tab('handover')}>Prepare bag handover</button>}</article>)}</div></>}
 {view === 'handover' && canBags && <DispatcherHandover drivers={drivers} user={user} onHistory={() => tab('history')} onPrepared={() => setHistoryVersion(v => v + 1)} />}
 {view === 'history' && canBags && <><div className="dp-heading"><div><p className="dp-eyebrow">EVERY BAG ACCOUNTED FOR</p><h1>Handover history.</h1><p>Exact bag counts, preparing staff and driver acceptance.</p></div><button onClick={() => setHistoryVersion(v => v + 1)} aria-label="Refresh history"><RefreshCw size={18} /></button></div><section className="dp-panel dp-history"><label className="dp-search"><Search size={18} /><input aria-label="Search handover history" placeholder="Driver, dispatcher, receipt or bag…" value={historySearch} onChange={e => setHistorySearch(e.target.value)} /></label><div className="dp-chips">{[['all', 'All'], ['pending', 'Awaiting acceptance'], ['accepted', 'Accepted'], ['partial', 'Partial / exception'], ['cancelled', 'Cancelled']].map(([key, label]) => <button key={key} aria-pressed={historyStatus === key} onClick={() => setHistoryStatus(key)}>{label}</button>)}</div>{historyLoading && <p role="status">Loading history…</p>}{historyError && <p className="dp-error" role="alert">{historyError}</p>}{historyTruncated && <p className="dp-help">Showing the 100 most recently active handover receipts. Older receipts are not included.</p>}{!historyLoading && !historyError && !receiptRows.length && <p className="dp-empty">No matching handover receipts.</p>}{receiptRows.map(r => <button className="dp-receipt-card" key={r.id} onClick={() => setModal({
            type: 'receipt',
            receipt: r
          })}><span className={`dp-pill ${r.status}`}>{r.status === 'pending' ? 'Awaiting acceptance' : r.status}</span><strong>{r.dispatcherName} → {r.driverName}</strong><small>{timestamp(r.preparedAt)}</small><span><b>{r.preparedCount}</b> prepared · <b>{r.acceptedCount}</b> accepted</span><small>{r.id}</small></button>)}</section></>}
 </main><nav className="dp-bottom-nav" aria-label="Mobile dispatcher navigation">{nav.map(([key, label, Icon]) => <button key={key} aria-current={view === key ? 'page' : undefined} className={view === key ? 'active' : ''} onClick={() => tab(key)}><Icon size={21} /><span>{label}</span></button>)}</nav>
 {modal?.type === 'filters' && <DispatcherFilters {...{
      filters,
      zones,
      drivers,
      emirates
    }} deliveries={deliveries} date={date} searchTerm={search} collections={collections} unassigned={unassigned} onClose={close} onApply={value => {
      setFilters(value);
      close();
    }} />}
 {modal?.type === 'date' && <DispatcherDialog title="Choose a date" onClose={close}><div className="dp-actions dp-date-shortcuts"><button onClick={() => changeDate(businessToday())}>Today</button><button className="primary" onClick={() => changeDate(shiftDay(businessToday(), 1))}>Tomorrow</button></div><form onSubmit={e => {
        e.preventDefault();
        changeDate(customDate);
      }}><label className="dp-field">Or select another date<input type="date" required value={customDate} onChange={e => setCustomDate(e.target.value)} /></label><button className="primary dp-full">Show deliveries</button></form></DispatcherDialog>}
 {['new', 'edit'].includes(modal?.type) && <DispatcherDeliveryForm delivery={modal.delivery} date={date} onClose={close} onSaved={value => {
      close();
      setSelected([]);
      setNotice(modal.type === 'new' ? 'Delivery created.' : 'Delivery updated.');
      if (value === date) load();else changeDate(value);
    }} />}
 {modal?.type === 'detail' && <DispatcherDialog title={modal.delivery.customerName || 'Delivery details'} onClose={close}>{detailLoading ? <p role="status">Loading delivery details…</p> : detail && <DeliveryDetails delivery={detail} drivers={drivers} onEdit={d => setModal({
        type: 'edit',
        delivery: d
      })} onAssign={openAssign} onUnassign={openUnassign} />} {formError && <p className="dp-error" role="alert">{formError}</p>}</DispatcherDialog>}
 {modal?.type === 'assign' && <DispatcherAssignment targets={modal.targets} deliveries={deliveries} drivers={drivers} date={date} onClose={close} onSaved={saved} />}
 {modal?.type === 'unassign' && <DispatcherDialog title="Unassign driver?" busy={busy} onClose={close}><p>Remove the driver assignment from {modal.targets.length} {modal.targets.length === 1 ? 'delivery' : 'deliveries'}?</p>{formError && <p className="dp-error" role="alert">{formError}</p>}<div className="dp-actions"><button disabled={busy} onClick={close}>Keep assignment</button><button disabled={busy || !modal.targets.length} onClick={unassign}>{busy ? 'Saving…' : 'Confirm unassign'}</button></div></DispatcherDialog>}
 {modal?.type === 'order' && <DispatcherOrder {...{
      date,
      drivers
    }} onClose={close} onSaved={saved} />}
 {modal?.type === 'events' && <DispatcherEvents onClose={close} />}
 {modal?.type === 'receipt' && <DispatcherDialog title="Handover receipt" onClose={close}><p className="dp-help">{modal.receipt.id}</p><div className="dp-detail-grid"><Cell label="Prepared by" value={modal.receipt.dispatcherName} /><Cell label="Receiving driver" value={modal.receipt.driverName} /><Cell label="Prepared bags" value={String(modal.receipt.preparedCount)} /><Cell label="Accepted bags" value={String(modal.receipt.acceptedCount)} /></div><p>{timestamp(modal.receipt.preparedAt)}</p><ol className="dp-timeline">{modal.receipt.bags.map(b => <li key={b.eventId}><strong>{b.bagId}</strong><small>{b.status}{b.acceptedAt ? ' · ' + timestamp(b.acceptedAt) : ''}</small></li>)}</ol><p>{modal.receipt.note}</p><p className="dp-help">Preparation alone does not transfer custody. Accepted counts come from the receiving driver's recorded acceptance.</p></DispatcherDialog>}
 </div>;
}
