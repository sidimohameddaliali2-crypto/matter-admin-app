import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../utils/api';

const TYPE_META = {
  truck: { label: 'Heavy Duty Truck', icon: 'local_shipping' },
  van: { label: 'Cargo Van', icon: 'airport_shuttle' },
  car: { label: 'Car', icon: 'directions_car' },
  bike: { label: 'Bike', icon: 'two_wheeler' },
};

const STATUS_META = {
  active: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700' },
  maintenance: { label: 'Maintenance', cls: 'bg-amber-50 text-amber-700' },
  idle: { label: 'Idle', cls: 'bg-gray-100 text-gray-600' },
  inactive: { label: 'Inactive', cls: 'bg-red-50 text-red-600' },
};

const fuelBarColor = (level) => {
  if (level >= 50) return 'bg-emerald-500';
  if (level >= 20) return 'bg-amber-500';
  return 'bg-red-500';
};

const EMPTY_FORM = {
  vehicleId: '',
  type: 'van',
  plateNumber: '',
  assignedDriver: '',
  status: 'idle',
  fuelLevel: 100,
  notes: '',
};

const inputCls = 'w-full bg-gray-50 border border-gray-200 rounded py-2 px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-colors';
const fieldLabelCls = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5';

function KpiCard({ icon, label, value, sub, subCls }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 sm:p-5 relative overflow-hidden">
      <span className="material-symbols-outlined absolute top-3 right-3 text-4xl text-gray-100">{icon}</span>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{label}</h3>
      <div className="flex items-end gap-2">
        <span className="text-3xl font-bold text-gray-900 leading-none">{value}</span>
        {sub && <span className={`text-xs font-semibold mb-0.5 ${subCls || 'text-gray-500'}`}>{sub}</span>}
      </div>
    </div>
  );
}

function VehicleFormModal({ initial, drivers, onClose, onSaved }) {
  const initialDriver = initial?.assignedDriver?._id ?? initial?.assignedDriver ?? '';
  const [form, setForm] = useState(() => initial ? { ...initial, assignedDriver: initialDriver } : EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const isEdit = Boolean(initial?._id);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.vehicleId.trim() || !form.plateNumber.trim()) {
      setError('Vehicle ID and Plate Number are required.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        vehicleId: form.vehicleId.trim(),
        type: form.type,
        plateNumber: form.plateNumber.trim(),
        ...((!isEdit || form.assignedDriver !== initialDriver) && { assignedDriver: form.assignedDriver || null }),
        status: form.status,
        fuelLevel: Number(form.fuelLevel) || 0,
        notes: form.notes,
      };
      if (isEdit) {
        await api.put(`/vehicles/${initial._id}`, payload);
      } else {
        await api.post('/vehicles', payload);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save vehicle.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-900">{isEdit ? 'Edit Vehicle' : 'Add Vehicle'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={fieldLabelCls}>Vehicle ID *</label>
              <input type="text" name="vehicleId" value={form.vehicleId} onChange={handleChange} placeholder="TRK-092" className={inputCls} required />
            </div>
            <div>
              <label className={fieldLabelCls}>Plate Number *</label>
              <input type="text" name="plateNumber" value={form.plateNumber} onChange={handleChange} placeholder="ABC-1234" className={inputCls} required />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={fieldLabelCls}>Type</label>
              <select name="type" value={form.type} onChange={handleChange} className={`${inputCls} appearance-none`}>
                {Object.entries(TYPE_META).map(([key, meta]) => (
                  <option key={key} value={key}>{meta.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={fieldLabelCls}>Status</label>
              <select name="status" value={form.status} onChange={handleChange} className={`${inputCls} appearance-none`}>
                {Object.entries(STATUS_META).map(([key, meta]) => (
                  <option key={key} value={key}>{meta.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={fieldLabelCls}>Assigned Driver</label>
              <select name="assignedDriver" value={form.assignedDriver || ''} onChange={handleChange} className={`${inputCls} appearance-none`}>
                <option value="">Unassigned</option>
                {drivers.map((d) => (
                  <option key={d._id} value={d._id}>{d.profile?.firstName} {d.profile?.lastName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={fieldLabelCls}>Fuel Level (%)</label>
              <input type="number" name="fuelLevel" min="0" max="100" value={form.fuelLevel} onChange={handleChange} className={inputCls} />
            </div>
          </div>

          <div>
            <label className={fieldLabelCls}>Notes</label>
            <textarea name="notes" value={form.notes} onChange={handleChange} rows={3} className={`${inputCls} resize-none`} placeholder="Optional notes…" />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 text-sm font-medium hover:text-gray-900 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Vehicle'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const fmtMoney = (n, currency = 'AED') =>
  `${currency} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const todayInput = () => new Date().toISOString().slice(0, 10);

function FuelLogModal({ vehicle, onClose, onChange }) {
  const [logs, setLogs] = useState([]);
  const [summary, setSummary] = useState({ count: 0, totalAmount: 0, totalLiters: 0, thisMonthAmount: 0, currency: 'AED' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ date: todayInput(), amount: '', liters: '', odometer: '', station: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/vehicles/${vehicle._id}/fuel-logs`);
      setLogs(res.data?.data || []);
      setSummary(res.data?.summary || { count: 0, totalAmount: 0, totalLiters: 0, thisMonthAmount: 0, currency: 'AED' });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load fuel logs.');
    } finally {
      setLoading(false);
    }
  }, [vehicle._id]);

  useEffect(() => { load(); }, [load]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!(Number(form.amount) > 0)) {
      setError('Enter a petrol amount greater than 0.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/vehicles/${vehicle._id}/fuel-logs`, {
        date: form.date || undefined,
        amount: Number(form.amount),
        liters: form.liters === '' ? null : Number(form.liters),
        odometer: form.odometer === '' ? null : Number(form.odometer),
        station: form.station.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      setForm({ date: todayInput(), amount: '', liters: '', odometer: '', station: '', notes: '' });
      await load();
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to log petrol expense.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (logId) => {
    setDeletingId(logId);
    try {
      await api.delete(`/vehicles/${vehicle._id}/fuel-logs/${logId}`);
      await load();
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete entry.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-blue-600">local_gas_station</span>
              Petrol Expenses
            </h3>
            <p className="text-xs text-gray-500 mt-0.5 font-mono">{vehicle.vehicleId} · {vehicle.plateNumber}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-6 space-y-5">
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">This Month</p>
              <p className="text-lg font-bold text-gray-900">{fmtMoney(summary.thisMonthAmount, summary.currency)}</p>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Total Spent</p>
              <p className="text-lg font-bold text-gray-900">{fmtMoney(summary.totalAmount, summary.currency)}</p>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Entries</p>
              <p className="text-lg font-bold text-gray-900">
                {summary.count}
                {summary.totalLiters > 0 && <span className="text-xs font-medium text-gray-500"> · {summary.totalLiters} L</span>}
              </p>
            </div>
          </div>

          {/* Add form */}
          <form onSubmit={handleSubmit} className="border border-gray-200 rounded-lg p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Log a fill-up</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className={fieldLabelCls}>Date</label>
                <input type="date" name="date" value={form.date} onChange={handleChange} className={inputCls} />
              </div>
              <div>
                <label className={fieldLabelCls}>Amount (AED) *</label>
                <input type="number" name="amount" min="0" step="0.01" value={form.amount} onChange={handleChange} placeholder="120" className={inputCls} required />
              </div>
              <div>
                <label className={fieldLabelCls}>Liters</label>
                <input type="number" name="liters" min="0" step="0.01" value={form.liters} onChange={handleChange} placeholder="optional" className={inputCls} />
              </div>
              <div>
                <label className={fieldLabelCls}>Odometer (km)</label>
                <input type="number" name="odometer" min="0" value={form.odometer} onChange={handleChange} placeholder="optional" className={inputCls} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={fieldLabelCls}>Station</label>
                <input type="text" name="station" value={form.station} onChange={handleChange} placeholder="ADNOC, ENOC…" className={inputCls} />
              </div>
              <div>
                <label className={fieldLabelCls}>Notes</label>
                <input type="text" name="notes" value={form.notes} onChange={handleChange} placeholder="Optional" className={inputCls} />
              </div>
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
                {submitting ? 'Saving…' : 'Add Expense'}
              </button>
            </div>
          </form>

          {/* History */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">History</p>
            {loading ? (
              <div className="text-center py-6 text-gray-400 text-sm">
                <span className="material-symbols-outlined animate-spin align-middle mr-2">progress_activity</span>
                Loading…
              </div>
            ) : logs.length === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm">No petrol expenses logged yet.</div>
            ) : (
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {logs.map((l) => (
                  <div key={l._id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm group">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900">{fmtMoney(l.amount, l.currency)}</span>
                        {l.liters ? <span className="text-xs text-gray-500">{l.liters} L</span> : null}
                        {l.station ? <span className="text-xs text-gray-500">· {l.station}</span> : null}
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        {new Date(l.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                        {l.odometer ? ` · ${Number(l.odometer).toLocaleString()} km` : ''}
                        {l.createdBy?.profile ? ` · ${l.createdBy.profile.firstName || ''} ${l.createdBy.profile.lastName || ''}`.trimEnd() : ''}
                        {l.notes ? ` · ${l.notes}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(l._id)}
                      disabled={deletingId === l._id}
                      title="Delete entry"
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button onClick={onClose} className="px-4 py-2 text-gray-700 text-sm font-medium hover:text-gray-900 transition-colors">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const FleetManagement = () => {
  const [vehicles, setVehicles] = useState([]);
  const [stats, setStats] = useState({ totalVehicles: 0, inService: 0, maintenanceRequired: 0, avgFuelLevel: 0, fuelSpend30d: 0 });
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0, limit: 10 });
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [page, setPage] = useState(1);

  const [formModal, setFormModal] = useState(null); // { } for add, vehicle object for edit
  const [deletingVehicle, setDeletingVehicle] = useState(null);
  const [fuelModalVehicle, setFuelModalVehicle] = useState(null);

  useEffect(() => {
    api.get('/drivers').then((res) => {
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || res.data?.drivers || []);
      setDrivers(list);
    }).catch(() => setDrivers([]));
  }, []);

  const fetchVehicles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/vehicles', {
        params: { search: search.trim() || undefined, status: statusFilter, type: typeFilter, page, limit: 10 },
      });
      setVehicles(res.data?.data || []);
      setStats(res.data?.stats || { totalVehicles: 0, inService: 0, maintenanceRequired: 0, avgFuelLevel: 0, fuelSpend30d: 0 });
      setPagination(res.data?.pagination || { page: 1, pages: 1, total: 0, limit: 10 });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load vehicles.');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, typeFilter, page]);

  useEffect(() => {
    const timer = setTimeout(fetchVehicles, 250);
    return () => clearTimeout(timer);
  }, [fetchVehicles]);

  useEffect(() => { setPage(1); }, [search, statusFilter, typeFilter]);

  const handleDelete = async () => {
    if (!deletingVehicle) return;
    try {
      await api.delete(`/vehicles/${deletingVehicle._id}`);
      setDeletingVehicle(null);
      fetchVehicles();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete vehicle.');
      setDeletingVehicle(null);
    }
  };

  const rangeLabel = useMemo(() => {
    if (pagination.total === 0) return 'Showing 0 vehicles';
    const start = (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.page * pagination.limit, pagination.total);
    return `Showing ${start} to ${end} of ${pagination.total} vehicles`;
  }, [pagination]);

  return (
    <div className="matter-analytics p-6 space-y-6 bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Fleet Management</h1>
          <p className="text-sm text-gray-500 mt-1">Manage fleet status, assignments, and vehicle records.</p>
        </div>
        <button
          onClick={() => setFormModal({})}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          Add Vehicle
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard icon="directions_car" label="Total Vehicles" value={stats.totalVehicles} />
        <KpiCard icon="check_circle" label="In Service" value={stats.inService} />
        <KpiCard
          icon="build"
          label="Maintenance Required"
          value={stats.maintenanceRequired}
          sub={stats.maintenanceRequired > 0 ? 'Attention' : undefined}
          subCls="px-2 py-0.5 rounded bg-amber-50 text-amber-600"
        />
        <KpiCard icon="local_gas_station" label="Avg Fuel Level" value={`${stats.avgFuelLevel}%`} />
        <KpiCard icon="payments" label="Petrol Spend (30d)" value={fmtMoney(stats.fuelSpend30d)} />
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[18px]">search</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vehicles or plates…"
            className="w-full pl-10 pr-3 py-2.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="flex-shrink-0 px-3 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
          <option value="all">Status: All</option>
          {Object.entries(STATUS_META).map(([key, meta]) => (
            <option key={key} value={key}>{meta.label}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="flex-shrink-0 px-3 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none">
          <option value="all">Type: All</option>
          {Object.entries(TYPE_META).map(([key, meta]) => (
            <option key={key} value={key}>{meta.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-600 rounded-lg text-sm">{error}</div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3">Vehicle ID</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Plate Number</th>
                <th className="px-4 py-3">Assigned Driver</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Fuel Level</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-sm text-gray-900">
              {loading ? (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400">
                  <span className="material-symbols-outlined animate-spin align-middle mr-2">progress_activity</span>
                  Loading vehicles…
                </td></tr>
              ) : vehicles.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400">No vehicles found</td></tr>
              ) : vehicles.map((v) => {
                const typeMeta = TYPE_META[v.type] || { label: v.type, icon: 'directions_car' };
                const statusMeta = STATUS_META[v.status] || STATUS_META.idle;
                const driverName = v.assignedDriver
                  ? `${v.assignedDriver.profile?.firstName || ''} ${v.assignedDriver.profile?.lastName || ''}`.trim()
                  : null;
                return (
                  <tr key={v._id} className="hover:bg-gray-50 transition-colors group">
                    <td className="px-4 py-3 font-mono text-blue-600 font-medium">{v.vehicleId}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 text-gray-700">
                        <span className="material-symbols-outlined text-gray-400 text-[18px]">{typeMeta.icon}</span>
                        {typeMeta.label}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono">{v.plateNumber}</td>
                    <td className="px-4 py-3">
                      {driverName ? driverName : <span className="text-gray-400 italic">Unassigned</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusMeta.cls}`}>
                        {statusMeta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full ${fuelBarColor(v.fuelLevel)}`} style={{ width: `${v.fuelLevel}%` }} />
                        </div>
                        <span className="text-[11px] text-gray-500 font-mono">{v.fuelLevel}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setFuelModalVehicle(v)} title="Log Petrol Expense" className="p-1.5 text-gray-500 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors">
                          <span className="material-symbols-outlined text-[18px]">local_gas_station</span>
                        </button>
                        <button onClick={() => setFormModal(v)} title="Edit Vehicle" className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors">
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button onClick={() => setDeletingVehicle(v)} title="Delete Vehicle" className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors">
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-between bg-white">
          <span className="text-sm text-gray-500">{rangeLabel}</span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pagination.page <= 1}
              className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[20px]">chevron_left</span>
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
              disabled={pagination.page >= pagination.pages}
              className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[20px]">chevron_right</span>
            </button>
          </div>
        </div>
      </div>

      {formModal && (
        <VehicleFormModal
          initial={formModal._id ? formModal : null}
          drivers={drivers}
          onClose={() => setFormModal(null)}
          onSaved={() => { setFormModal(null); fetchVehicles(); }}
        />
      )}

      {fuelModalVehicle && (
        <FuelLogModal
          vehicle={fuelModalVehicle}
          onClose={() => setFuelModalVehicle(null)}
          onChange={fetchVehicles}
        />
      )}

      {deletingVehicle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Delete Vehicle</h3>
            <p className="text-sm text-gray-600 mb-5">
              Are you sure you want to delete <span className="font-semibold">{deletingVehicle.vehicleId}</span>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeletingVehicle(null)} className="px-4 py-2 text-gray-700 text-sm font-medium hover:text-gray-900 transition-colors">
                Cancel
              </button>
              <button onClick={handleDelete} className="px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold hover:opacity-90 transition-opacity">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FleetManagement;
