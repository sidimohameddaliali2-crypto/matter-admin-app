import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Package, Search, ShieldCheck, X } from 'lucide-react';
import api from '../../utils/api';
import WarehouseScanInput from '../bags/WarehouseScanInput';
import { matchingBagLabels, normalizeBagLabel } from '../../utils/bagLabelLookup';
import { errorMessage, newRequestId, staffName } from '../../utils/dispatcher';
export default function DispatcherHandover({
  drivers,
  user,
  onHistory,
  onPrepared
}) {
  const [step, setStep] = useState(1),
    [driver, setDriver] = useState(''),
    [search, setSearch] = useState(''),
    [bags, setBags] = useState([]),
    [selected, setSelected] = useState([]),
    [note, setNote] = useState(''),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [result, setResult] = useState(null),
    [attempted, setAttempted] = useState(false);
  const request = useRef(null),
    lock = useRef(false);
  if (!request.current) request.current = newRequestId();
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let page = 1,
        pages = 1,
        rows = [];
      do {
        const r = await api.get('/bags', {
          params: {
            status: 'available',
            location: 'warehouse',
            page,
            limit: 500
          }
        });
        rows.push(...r.data.data);
        pages = r.data.pagination?.totalPages || 1;
        page++;
      } while (page <= pages);
      setBags(rows.filter(b => b.lifecycleState === 'ready' && !b.isFlagged && b.condition !== 'poor' && b.isActive !== false));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const reset = () => {
    request.current = newRequestId();
    setStep(1);
    setDriver('');
    setSearch('');
    setSelected([]);
    setNote('');
    setChecked(false);
    setResult(null);
    setAttempted(false);
    load();
  };
  const scan = useCallback(codes => {
    const code = normalizeBagLabel(codes?.[0]?.rawValue);
    if (!code) return;
    if (code.length > 160) {
      setError('Bag tags must be 160 characters or fewer. This scan was not added.');
      return;
    }
    const matches = matchingBagLabels(bags, code);
    if (matches.length !== 1) {
      setError(matches.length ? 'Duplicate stock records match this tag. Ask the warehouse to reconcile it.' : 'This bag is not clean, ready warehouse stock. Check the physical tag.');
      return;
    }
    setSelected(current => current.some(b => b._id === matches[0]._id) ? current : current.length >= 500 ? current : [...current, matches[0]]);
    setError('');
    setChecked(false);
  }, [bags]);
  const submit = async () => {
    if (lock.current || !checked || !driver || !selected.length) return;
    lock.current = true;
    setBusy(true);
    setAttempted(true);
    setError('');
    try {
      const r = await api.post('/dispatcher-handovers', {
        requestId: request.current,
        confirmed: checked,
        driverId: driver,
        bags: selected.map(b => ({
          bagId: b.bagId,
          expectedVersion: b.custodyVersion || 0
        })),
        note
      });
      setResult(r.data.data);
      setStep(4);
      onPrepared();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  const recipient = drivers.find(d => String(d._id) === driver),
    matches = drivers.filter(d => (staffName(d) + ' ' + (d.email || '')).toLowerCase().includes(search.trim().toLowerCase()));
  return <><div className="dp-heading"><div><p className="dp-eyebrow">DISPATCHER → DRIVER</p><h1>Bag handover.</h1><p>Every bag traced to the person who prepares it.</p></div><button onClick={onHistory}>Handover history</button></div><div className="dp-audit"><ShieldCheck size={24} /><div><strong>Prepared by {staffName(user)}</strong><p>Your identity and the exact bag IDs are recorded. Driver acceptance transfers custody.</p></div></div>{error && <p className="dp-error" role="alert">{error} {!attempted && <button onClick={load}>Refresh stock</button>}</p>}<div className="dp-handover-layout"><section className="dp-panel dp-flow">{step < 4 && <div className="dp-steps">{['Receiving driver', 'Check bags', 'Review'].map((label, i) => <span className={step === i + 1 ? 'active' : ''} key={label}><b>{i + 1}</b>{label}</span>)}</div>}
 {step === 1 && <><h2>Who receives the bags?</h2><label className="dp-search"><Search size={18} /><input aria-label="Search receiving drivers" placeholder="Search for a driver…" value={search} onChange={e => setSearch(e.target.value)} /></label><p className="dp-help">{matches.length} {matches.length === 1 ? 'matching driver' : 'matching drivers'}</p><div className="dp-driver-choices" role="group" aria-label="Drivers available for bag handover">{matches.map(d => <button key={d._id} aria-pressed={driver === String(d._id)} onClick={() => setDriver(String(d._id))}><span className="dp-avatar">{staffName(d).slice(0, 2).toUpperCase()}</span><span><strong>{staffName(d)}</strong><small>{d.profile?.vehicleType || d.email}</small></span>{driver === String(d._id) ? <Check size={20} /> : <ArrowRight size={20} />}</button>)}</div>{!matches.length && <p className="dp-empty">{drivers.length ? 'No receiving drivers match this search.' : 'No active drivers available.'}</p>}<button className="primary dp-full" disabled={!driver} onClick={() => setStep(2)}>Continue to bags <ArrowRight size={17} /></button></>}
 {step === 2 && <><h2>Check the physical bags.</h2><p className="dp-help">Scan clean, ready warehouse tags. Each tag counts once.</p>{loading ? <p role="status">Loading ready stock…</p> : <WarehouseScanInput onScan={scan} disabled={busy} />}<h3>{selected.length} bags in this handover</h3><div className="dp-taglist">{selected.map(b => <span key={b._id}>{b.bagId}<button aria-label={`Remove ${b.bagId}`} onClick={() => {
                setSelected(current => current.filter(x => x._id !== b._id));
                setChecked(false);
              }}><X size={16} /></button></span>)}</div><details><summary>Choose from ready stock ({bags.length})</summary><div className="dp-stock-list">{bags.slice(0, 30).map(b => <button key={b._id} aria-pressed={selected.some(x => x._id === b._id)} onClick={() => scan([{
                rawValue: b.bagId
              }])}><Package size={18} />{b.bagId}</button>)}</div><p className="dp-help">Scan a tag to find ready stock beyond this list.</p></details><div className="dp-actions"><button onClick={() => setStep(1)}>Back</button><button className="primary" disabled={!selected.length || loading} onClick={() => setStep(3)}>Review handover</button></div></>}
 {step === 3 && <><h2>Review the handover.</h2><div className="dp-summary-row"><span>Prepared by</span><strong>{staffName(user)}</strong></div><div className="dp-summary-row"><span>Receiving driver</span><strong>{recipient ? staffName(recipient) : 'Not selected'}</strong></div><div className="dp-quantity"><strong>{selected.length}</strong><span>physical bags</span></div><div className="dp-taglist">{selected.map(b => <span key={b._id}>{b.bagId}</span>)}</div><label className="dp-field">Handover note (optional)<textarea maxLength={2000} disabled={busy || attempted} value={note} onChange={e => setNote(e.target.value)} /></label><label className="dp-check"><input type="checkbox" checked={checked} disabled={busy} onChange={e => setChecked(e.target.checked)} />I checked these exact physical bag tags for this receiving driver.</label>{attempted && <p className="dp-help">Retry uses the same request to avoid preparing a bag twice. Start a new handover to change its contents.</p>}<div className="dp-actions">{!attempted && <button disabled={busy} onClick={() => setStep(2)}>Back to bags</button>}<button className="primary" disabled={busy || !checked} onClick={submit}>{busy ? 'Preparing…' : attempted ? 'Retry handover' : 'Confirm physical handover'}</button></div></>}
 {step === 4 && result && <><div className="dp-success-icon"><Check size={30} /></div><h2>{result.successes.length} bags prepared.</h2><p>Awaiting receiving-driver acceptance. These bags remain in warehouse custody.</p><p className="dp-help">Receipt {result.id}</p><div className="dp-taglist">{result.successes.map(b => <span key={b.bagId}>{b.bagId}</span>)}</div>{result.failures.length > 0 && <div className="dp-warning"><strong>{result.failures.length} bags were not prepared</strong><ul>{result.failures.map(b => <li key={b.bagId}>{b.bagId}: {b.message}</li>)}</ul><button disabled={busy} onClick={submit}>Retry the same handover</button></div>}<div className="dp-actions"><button onClick={onHistory}>View history</button><button className="primary" onClick={reset}>Start another handover</button></div></>}
 </section><aside className="dp-panel dp-handover-summary"><p className="dp-eyebrow">HANDOVER SUMMARY</p><h3>{recipient ? staffName(recipient) : 'Choose a receiving driver'}</h3><div className="dp-quantity"><strong>{selected.length}</strong><span>bags selected</span></div><p>Preparation records your accountability. Only the nominated receiving driver can accept custody.</p></aside></div></>;
}
