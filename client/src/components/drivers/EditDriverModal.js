import React, { useState, useRef, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion, AnimatePresence } from 'framer-motion';
import { updateDriver } from '../../store/slices/driverSlice';
import { uploadPhoto } from '../../utils/fileUpload';
import api from '../../utils/api';

const toDateInput = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

const buildFormFromDriver = (driver) => ({
  fullName: [driver?.profile?.firstName, driver?.profile?.lastName].filter(Boolean).join(' '),
  email: driver?.email || '',
  phone: driver?.profile?.phone || '',
  colorCode: driver?.profile?.colorCode || '#000000',
  licenseNumber: driver?.profile?.licenseNumber || '',
  licenseExpiry: toDateInput(driver?.profile?.licenseExpiry),
  nationalId: driver?.profile?.nationalId || '',
  status: driver?.profile?.status || 'available',
  assignedZone: driver?.profile?.assignedZone || '',
  shiftTiming: driver?.profile?.shiftTiming || '',
  vehicleType: driver?.profile?.vehicleType || '',
  vehicleId: driver?.profile?.vehicleId || '',
  truckoomVehicleNo: driver?.profile?.truckoomVehicleNo || '',
  stopCapacity: driver?.profile?.stopCapacity ?? '',
  baseSalary: driver?.profile?.baseSalary ?? '',
  contractType: driver?.profile?.contractType || 'full_time',
  joiningDate: toDateInput(driver?.profile?.joiningDate)
});

const EditDriverModal = ({ driver, onClose }) => {
  const dispatch = useDispatch();
  const { isLoading } = useSelector((state) => state.driver);
  const drivers = useSelector((state) => state.driver.drivers);
  const driversArray = Array.isArray(drivers) ? drivers : (drivers?.data || drivers?.drivers || []);

  const zoneOptions = React.useMemo(() => {
    const zones = new Set();
    driversArray.forEach((d) => {
      const z = d?.profile?.assignedZone?.trim();
      if (z) zones.add(z);
    });
    return Array.from(zones).sort((a, b) => a.localeCompare(b));
  }, [driversArray]);

  const [formData, setFormData] = useState(() => buildFormFromDriver(driver));
  const initialTruckoomVehicleNo = useRef(formData.truckoomVehicleNo);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');

  const [vehiclePaperFile, setVehiclePaperFile] = useState(null);
  const [vehiclePaperPreview, setVehiclePaperPreview] = useState(driver?.profile?.vehiclePaper || null);
  const [uploadingVehiclePaper, setUploadingVehiclePaper] = useState(false);
  const vehiclePaperInputRef = useRef(null);

  // Truckoom-tracked vehicles, for the "Truckoom Vehicle" dropdown below —
  // fetched once; if the API isn't reachable/configured the dropdown just
  // shows the driver's already-saved value (if any) plus nothing else,
  // rather than blocking the rest of the form.
  const [truckoomVehicles, setTruckoomVehicles] = useState([]);
  useEffect(() => {
    api.get('/truckoom/vehicles')
      .then((res) => setTruckoomVehicles(res.data?.data || []))
      .catch(() => setTruckoomVehicles([]));
  }, []);

  useEffect(() => {
    const nextForm = buildFormFromDriver(driver);
    initialTruckoomVehicleNo.current = nextForm.truckoomVehicleNo;
    setFormData(nextForm);
    setVehiclePaperPreview(driver?.profile?.vehiclePaper || null);
    setVehiclePaperFile(null);
  }, [driver]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: '' }));
    if (error) setError('');
  };

  const handleVehiclePaperChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setErrors((prev) => ({ ...prev, vehiclePaper: 'File size must be less than 5MB' }));
      return;
    }
    if (!file.type.startsWith('image/')) {
      setErrors((prev) => ({ ...prev, vehiclePaper: 'Please upload an image (photo or scan of the document)' }));
      return;
    }
    setVehiclePaperFile(file);
    setErrors((prev) => ({ ...prev, vehiclePaper: '' }));
    const reader = new FileReader();
    reader.onload = (ev) => setVehiclePaperPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.fullName.trim()) newErrors.fullName = 'Full name is required';
    if (!formData.email.trim()) newErrors.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(formData.email)) newErrors.email = 'Email is invalid';
    if (!formData.phone.trim()) newErrors.phone = 'Phone number is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const inputCls = (field) =>
    `w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
      errors[field] ? 'border-red-500' : 'border-gray-300'
    }`;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const trimmedName = formData.fullName.trim().replace(/\s+/g, ' ');
    const spaceIndex = trimmedName.indexOf(' ');
    const firstName = spaceIndex === -1 ? trimmedName : trimmedName.slice(0, spaceIndex);
    const lastName = spaceIndex === -1 ? '' : trimmedName.slice(spaceIndex + 1);

    try {
      let vehiclePaperUrl = driver?.profile?.vehiclePaper;
      if (vehiclePaperFile) {
        setUploadingVehiclePaper(true);
        try {
          vehiclePaperUrl = await uploadPhoto(vehiclePaperPreview);
        } finally {
          setUploadingVehiclePaper(false);
        }
      }

      await dispatch(updateDriver({
        id: driver._id,
        driverData: {
          firstName,
          lastName,
          email: formData.email,
          phone: formData.phone,
          status: formData.status,
          colorCode: formData.colorCode,
          profile: {
            licenseNumber: formData.licenseNumber || undefined,
            licenseExpiry: formData.licenseExpiry || undefined,
            nationalId: formData.nationalId || undefined,
            assignedZone: formData.assignedZone || undefined,
            shiftTiming: formData.shiftTiming || undefined,
            vehicleType: formData.vehicleType || undefined,
            vehicleId: formData.vehicleId || undefined,
            ...(formData.truckoomVehicleNo !== initialTruckoomVehicleNo.current
              && { truckoomVehicleNo: formData.truckoomVehicleNo || null }),
            stopCapacity: formData.stopCapacity !== '' ? Number(formData.stopCapacity) : undefined,
            vehiclePaper: vehiclePaperUrl || undefined,
            baseSalary: formData.baseSalary !== '' ? Number(formData.baseSalary) : undefined,
            contractType: formData.contractType || undefined,
            joiningDate: formData.joiningDate || undefined
          }
        }
      })).unwrap();

      onClose();
    } catch (err) {
      setError(err?.message || 'Failed to update driver');
    }
  };

  return (
    <AnimatePresence>
      <div className="matter-analytics fixed inset-0 z-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black bg-opacity-50"
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10 rounded-t-xl">
            <h2 className="text-lg font-semibold text-gray-900">Edit Driver Profile</h2>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg text-sm">{error}</div>
            )}

            {/* Profile Information */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-900">Profile Information</h3>
              <p className="text-xs text-gray-500 mb-4">Basic contact details and sticker color.</p>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Full Name *</label>
                  <input type="text" name="fullName" value={formData.fullName} onChange={handleChange} className={inputCls('fullName')} />
                  {errors.fullName && <p className="mt-1 text-xs text-red-600">{errors.fullName}</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Sticker Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      name="colorCode"
                      value={formData.colorCode}
                      onChange={handleChange}
                      className="w-10 h-9 border border-gray-300 rounded cursor-pointer"
                    />
                    <span className="text-xs font-mono text-gray-600">{formData.colorCode}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Email Address *</label>
                  <input type="email" name="email" value={formData.email} onChange={handleChange} className={inputCls('email')} />
                  {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email}</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Phone Number *</label>
                  <input type="tel" name="phone" value={formData.phone} onChange={handleChange} className={inputCls('phone')} />
                  {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone}</p>}
                </div>
              </div>
            </div>

            {/* License & Identification */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-900">License & Identification</h3>
              <p className="text-xs text-gray-500 mb-4">Legal driving documents.</p>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Driving License Number</label>
                  <input type="text" name="licenseNumber" value={formData.licenseNumber} onChange={handleChange} className={inputCls('licenseNumber')} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">License Expiry Date</label>
                  <input type="date" name="licenseExpiry" value={formData.licenseExpiry} onChange={handleChange} className={inputCls('licenseExpiry')} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">National ID</label>
                  <input type="text" name="nationalId" value={formData.nationalId} onChange={handleChange} className={inputCls('nationalId')} />
                </div>
              </div>
            </div>

            {/* Employment Details */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-900">Employment Details</h3>
              <p className="text-xs text-gray-500 mb-4">Operational assignments and scheduling.</p>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Driver Status</label>
                  <select name="status" value={formData.status} onChange={handleChange} className={inputCls('status')}>
                    <option value="available">Active</option>
                    <option value="busy">Busy</option>
                    <option value="offline">Offline</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Assigned Zone</label>
                  <input type="text" name="assignedZone" list="edit-zone-options" value={formData.assignedZone} onChange={handleChange} className={inputCls('assignedZone')} />
                  <datalist id="edit-zone-options">
                    {zoneOptions.map((z) => <option key={z} value={z} />)}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Shift Timing</label>
                  <select name="shiftTiming" value={formData.shiftTiming} onChange={handleChange} className={inputCls('shiftTiming')}>
                    <option value="">Select Shift</option>
                    <option value="morning">Morning (6AM–2PM)</option>
                    <option value="afternoon">Afternoon (2PM–10PM)</option>
                    <option value="night">Night (10PM–6AM)</option>
                    <option value="flexible">Flexible / Full Day</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Vehicle */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-900">Vehicle</h3>
              <p className="text-xs text-gray-500 mb-4">Assigned vehicle and registration document.</p>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Vehicle Type</label>
                  <select name="vehicleType" value={formData.vehicleType} onChange={handleChange} className={inputCls('vehicleType')}>
                    <option value="">Select Type</option>
                    <option value="bike">Bike</option>
                    <option value="van">Van</option>
                    <option value="car">Car</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Max Stops / Route</label>
                  <input
                    type="number"
                    min="1"
                    name="stopCapacity"
                    value={formData.stopCapacity}
                    onChange={handleChange}
                    placeholder={formData.vehicleType === 'bike' ? 'Default 20' : formData.vehicleType === 'van' ? 'Default 100' : 'Default by vehicle'}
                    className={inputCls('stopCapacity')}
                  />
                  <p className="mt-1 text-[11px] text-gray-500">Leave blank to use the vehicle-type default (bike 20, van 100).</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Vehicle ID</label>
                  <input type="text" name="vehicleId" value={formData.vehicleId} onChange={handleChange} placeholder="e.g. DXB-A-12345" className={inputCls('vehicleId')} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Truckoom Vehicle (GPS)</label>
                  <select name="truckoomVehicleNo" value={formData.truckoomVehicleNo} onChange={handleChange} className={inputCls('truckoomVehicleNo')}>
                    <option value="">— None —</option>
                    {truckoomVehicles.map((v) => (
                      <option key={v.vehicleNo} value={v.vehicleNo}>
                        {v.vehicleNo}{v.deviceName ? ` — ${v.deviceName}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-gray-500">Links this driver to their real GPS-tracked vehicle, for Live Tracking and Driver Routes.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Registration Paper</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => vehiclePaperInputRef.current?.click()}
                      className="w-10 h-10 flex-shrink-0 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center overflow-hidden hover:bg-gray-50 transition-colors"
                    >
                      {vehiclePaperPreview ? (
                        <img src={vehiclePaperPreview} alt="Preview" className="w-full h-full object-cover" />
                      ) : (
                        <span className="material-symbols-outlined text-gray-400 text-[18px]">description</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => vehiclePaperInputRef.current?.click()}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      {vehiclePaperPreview ? 'Replace' : 'Upload'}
                    </button>
                    <input
                      ref={vehiclePaperInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleVehiclePaperChange}
                      className="hidden"
                    />
                  </div>
                  {errors.vehiclePaper && <p className="mt-1 text-[11px] text-red-600">{errors.vehiclePaper}</p>}
                </div>
              </div>
            </div>

            {/* Salary & Contract */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-900">Salary & Contract</h3>
              <p className="text-xs text-gray-500 mb-4">Financial and agreement details.</p>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Base Salary (AED)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">AED</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      name="baseSalary"
                      value={formData.baseSalary}
                      onChange={handleChange}
                      className={`${inputCls('baseSalary')} pl-11`}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Contract Type</label>
                  <select name="contractType" value={formData.contractType} onChange={handleChange} className={inputCls('contractType')}>
                    <option value="full_time">Full-Time</option>
                    <option value="part_time">Part-Time</option>
                    <option value="contract">Contract</option>
                    <option value="temporary">Temporary</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Joining Date</label>
                  <input type="date" name="joiningDate" value={formData.joiningDate} onChange={handleChange} className={inputCls('joiningDate')} />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                disabled={isLoading || uploadingVehiclePaper}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading || uploadingVehiclePaper}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {uploadingVehiclePaper ? 'Uploading document…' : isLoading ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default EditDriverModal;
