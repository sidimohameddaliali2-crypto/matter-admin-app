import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { createEvent } from '../../store/slices/eventSlice';
import api from '../../utils/api';
import { X, Plus, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const CreateEventModal = ({ isOpen, onClose }) => {
    const DEFAULT_VENUE_TYPES_BY_COMPANY = {
      Matter: ['Gym', 'Outdoor Set up', 'Other'],
      'Yellow Block': ['Private Villa', 'Hotel', 'Restaurant', 'Beach', 'Park', 'Convention Center', 'Other']
    };

    const ensureOtherOption = (types = []) => {
      if (!Array.isArray(types)) return ['Other'];
      const hasOther = types.some((type) => String(type).trim().toLowerCase() === 'other');
      return hasOther ? types : [...types, 'Other'];
    };

    const loadVenueTypesByCompany = () => {
      try {
        const stored = localStorage.getItem('eventCompanyVenueProfiles');
        if (!stored) {
          return DEFAULT_VENUE_TYPES_BY_COMPANY;
        }

        const parsed = JSON.parse(stored);
        const normalized = Object.entries(parsed || {}).reduce((acc, [company, types]) => {
          acc[company] = ensureOtherOption(types);
          return acc;
        }, {});
        return {
          ...Object.entries(DEFAULT_VENUE_TYPES_BY_COMPANY).reduce((acc, [company, types]) => {
            acc[company] = ensureOtherOption(types);
            return acc;
          }, {}),
          ...normalized
        };
      } catch {
        return Object.entries(DEFAULT_VENUE_TYPES_BY_COMPANY).reduce((acc, [company, types]) => {
          acc[company] = ensureOtherOption(types);
          return acc;
        }, {});
      }
    };

  const dispatch = useDispatch();
  const { user } = useSelector((state) => state.auth);
  const { isLoading } = useSelector((state) => state.events);

  // Function to get company color based on company name
  const getCompanyColor = (companyName) => {
    const colorMap = {
      'Yellow Block': {
        bg: '#f6bcf6',
        bgFrom: '#f6bcf6',
        bgTo: '#f0a3ed',
        light: '#ffe6ff',
        lighter: '#fff5ff',
        text: '#8b2e6f',
        textLight: '#c44a9e',
        border: '#e8aee8'
      }
    };
    
    return colorMap[companyName] || {
      bg: '#3b82f6',
      bgFrom: '#3b82f6',
      bgTo: '#2563eb',
      light: '#dbeafe',
      lighter: '#f0f9ff',
      text: '#1e40af',
      textLight: '#3b82f6',
      border: '#93c5fd'
    };
  };

  // derive company name from the logged‑in user so the field is not editable
  // available companies and their stored logos
  const companyOptions = [
    {
      value: 'Matter',
      label: 'Matter',
      logo: '/images/matter-logo24-white.png'
    },
    {
      value: 'Yellow Block',
      label: 'Yellow Block',
      logo: '/images/yellow-block-logo.png'
    }
  ];

  const defaultCompanyName = companyOptions[0].value; // default to Matter

  const [formData, setFormData] = useState({
    eventName: '',
    companyName: defaultCompanyName,
    companyId: user?.profile?._id || '',
    // logo preset from mapping
    companyLogo: companyOptions[0].logo,
    driverProvider: 'yellow_block',
    eventDate: '',
    emirate: 'Dubai',
    venue: {
      type: 'Gym',
      address: '',
      area: '',
      googleMapsLink: ''
    },
    arrivalTime: '15:00',
    pointOfContact: {
      noPointOfContact: false,
      name: '',
      phone: '',
      email: ''
    },
    flowerCollection: {
      shopLocation: '',
      flowerCount: 1,
      pictureUrl: ''
    },
    logistics: {
      noLogisticsNeeded: false,
      numberOfPeople: 1,
      staffNames: [''],
      specialRequests: '',
      equipment: [],
      assetsUsed: [],
      food: []
    },
    disassembly: {
      isRequired: false,
      date: '',
      arrivalTime: '',
      disassemblyTime: '',
      notes: ''
    },
    isPaid: false,
    notes: ''
  });

  const [newEquipment, setNewEquipment] = useState({ name: '', dimensions: '', description: '', quantity: 1 });
  const [newFood, setNewFood] = useState({ name: '', quantity: 1, description: '' });
  const [venueTypesByCompany, setVenueTypesByCompany] = useState(loadVenueTypesByCompany);
  const [newVenueType, setNewVenueType] = useState('');

  // Equipment / food options fetched from server (keyed by company name)
  const [equipmentOptionsByCompany, setEquipmentOptionsByCompany] = useState({});
  const [foodOptionsByCompany, setFoodOptionsByCompany] = useState({});
  const [newEquipmentOption, setNewEquipmentOption] = useState({ name: '', dimensions: '', description: '' });
  const [newFoodOption, setNewFoodOption] = useState({ name: '', description: '' });
  const [selectedEquipmentOption, setSelectedEquipmentOption] = useState('');
  const [selectedFoodOption, setSelectedFoodOption] = useState('');
  const [availableAssets, setAvailableAssets] = useState([]);
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [selectedAssetQuantity, setSelectedAssetQuantity] = useState(1);
  const [isUploadingFlowerImage, setIsUploadingFlowerImage] = useState(false);

  const isMatter = formData.companyName === 'Matter';

  const emirates = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];

  const venueTypes = useMemo(() => {
    const companyTypes = venueTypesByCompany?.[formData.companyName];
    if (Array.isArray(companyTypes) && companyTypes.length > 0) {
      return ensureOtherOption(companyTypes);
    }
    return ensureOtherOption(
      DEFAULT_VENUE_TYPES_BY_COMPANY[formData.companyName] || DEFAULT_VENUE_TYPES_BY_COMPANY['Yellow Block']
    );
  }, [formData.companyName, venueTypesByCompany]);

  useEffect(() => {
    localStorage.setItem('eventCompanyVenueProfiles', JSON.stringify(venueTypesByCompany));
  }, [venueTypesByCompany]);

  useEffect(() => {
    if (!venueTypes.includes(formData.venue.type)) {
      setFormData((prev) => ({
        ...prev,
        venue: {
          ...prev.venue,
          type: venueTypes[0] || ''
        }
      }));
    }
  }, [venueTypes, formData.venue.type]);

  // Fetch options from server whenever company changes
  useEffect(() => {
    if (!formData.companyName) return;
    api.get(`/events/options/${encodeURIComponent(formData.companyName)}`)
      .then((res) => {
        if (res.data?.success) {
          const { company, equipment = [], food = [] } = res.data.data;
          setEquipmentOptionsByCompany((prev) => ({ ...prev, [company]: equipment }));
          setFoodOptionsByCompany((prev) => ({ ...prev, [company]: food }));
        }
      })
      .catch((err) => console.warn('Could not load event options:', err.message));
  }, [formData.companyName]);

  // Get current company's equipment and food options
  const currentEquipmentOptions = useMemo(() => {
    return equipmentOptionsByCompany?.[formData.companyName] || [];
  }, [equipmentOptionsByCompany, formData.companyName]);

  const currentFoodOptions = useMemo(() => {
    return foodOptionsByCompany?.[formData.companyName] || [];
  }, [foodOptionsByCompany, formData.companyName]);

  // Reset selected options when company changes
  useEffect(() => {
    setSelectedEquipmentOption('');
    setSelectedFoodOption('');
    setNewEquipment({ name: '', dimensions: '', description: '', quantity: 1 });
    setNewFood({ name: '', quantity: 1, description: '' });
    setSelectedAssetId('');
    setSelectedAssetQuantity(1);
  }, [formData.companyName]);

  useEffect(() => {
    if (formData.companyName !== 'Yellow Block') {
      setAvailableAssets([]);
      return;
    }

    api.get('/yellowblock/assets', { params: { companyName: 'Yellow Block' } })
      .then((res) => {
        setAvailableAssets(res.data?.assets || []);
      })
      .catch((err) => console.warn('Could not load Yellow Block assets:', err.message));
  }, [formData.companyName]);

  const handleInputChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const handleVenueChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      venue: {
        ...prev.venue,
        [field]: value
      }
    }));
  };

  const handleAddVenueType = () => {
    const trimmedVenue = newVenueType.trim();
    if (!trimmedVenue) {
      return;
    }

    const exists = venueTypes.some((type) => type.toLowerCase() === trimmedVenue.toLowerCase());
    if (exists) {
      setNewVenueType('');
      return;
    }

    setVenueTypesByCompany((prev) => {
      const current = Array.isArray(prev?.[formData.companyName]) && prev[formData.companyName].length > 0
        ? prev[formData.companyName]
        : ensureOtherOption(DEFAULT_VENUE_TYPES_BY_COMPANY[formData.companyName] || []);
      return {
        ...prev,
        [formData.companyName]: ensureOtherOption([...current.filter((type) => type !== 'Other'), trimmedVenue, 'Other'])
      };
    });

    handleVenueChange('type', trimmedVenue);
    setNewVenueType('');
  };

  const handleLogisticsChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      logistics: {
        ...prev.logistics,
        [field]: value
      }
    }));
  };

  const handleNoLogisticsToggle = (checked) => {
    setFormData((prev) => ({
      ...prev,
      logistics: checked
        ? {
            ...prev.logistics,
            noLogisticsNeeded: true,
            numberOfPeople: 0,
            staffNames: [],
            specialRequests: '',
            equipment: [],
            assetsUsed: []
          }
        : {
            ...prev.logistics,
            noLogisticsNeeded: false,
            numberOfPeople: prev.logistics.numberOfPeople > 0 ? prev.logistics.numberOfPeople : 1,
            staffNames: prev.logistics.staffNames.length > 0 ? prev.logistics.staffNames : ['']
          }
    }));
  };

  const handleStaffNameChange = (index, value) => {
    const newStaffNames = [...formData.logistics.staffNames];
    newStaffNames[index] = value;
    handleLogisticsChange('staffNames', newStaffNames);
  };

  const addStaffName = () => {
    handleLogisticsChange('staffNames', [...formData.logistics.staffNames, '']);
  };

  const removeStaffName = (index) => {
    const newStaffNames = formData.logistics.staffNames.filter((_, i) => i !== index);
    handleLogisticsChange('staffNames', newStaffNames);
  };

  const addEquipment = () => {
    if (selectedEquipmentOption) {
      const selectedEquip = currentEquipmentOptions.find(e => e.name === selectedEquipmentOption);
      if (selectedEquip) {
        const newItem = { ...selectedEquip, quantity: newEquipment.quantity || 1 };
        handleLogisticsChange('equipment', [...formData.logistics.equipment, newItem]);
        setSelectedEquipmentOption('');
        setNewEquipment({ name: '', dimensions: '', description: '', quantity: 1 });
      }
    }
  };

  const addNewEquipmentOption = async () => {
    if (!newEquipmentOption.name.trim()) return;
    const newOption = { name: newEquipmentOption.name.trim(), dimensions: newEquipmentOption.dimensions, description: newEquipmentOption.description };
    const updatedEquipment = [...(equipmentOptionsByCompany[formData.companyName] || []), newOption];
    const updatedFood = foodOptionsByCompany[formData.companyName] || [];
    setEquipmentOptionsByCompany((prev) => ({ ...prev, [formData.companyName]: updatedEquipment }));
    setSelectedEquipmentOption(newOption.name);
    setNewEquipmentOption({ name: '', dimensions: '', description: '' });
    try {
      await api.put(`/events/options/${encodeURIComponent(formData.companyName)}`, { equipment: updatedEquipment, food: updatedFood });
    } catch (err) {
      console.warn('Could not save equipment options to server:', err.message);
    }
  };

  const removeEquipment = (index) => {
    const newEquipmentList = formData.logistics.equipment.filter((_, i) => i !== index);
    handleLogisticsChange('equipment', newEquipmentList);
  };

  const addFood = () => {
    if (selectedFoodOption) {
      const selectedFoodItem = currentFoodOptions.find(f => f.name === selectedFoodOption);
      if (selectedFoodItem) {
        const newItem = { ...selectedFoodItem, quantity: newFood.quantity || 1 };
        handleLogisticsChange('food', [...formData.logistics.food, newItem]);
        setSelectedFoodOption('');
        setNewFood({ name: '', quantity: 1, description: '' });
      }
    }
  };

  const addNewFoodOption = async () => {
    if (!newFoodOption.name.trim()) return;
    const newOption = { name: newFoodOption.name.trim(), description: newFoodOption.description };
    const updatedFood = [...(foodOptionsByCompany[formData.companyName] || []), newOption];
    const updatedEquipment = equipmentOptionsByCompany[formData.companyName] || [];
    setFoodOptionsByCompany((prev) => ({ ...prev, [formData.companyName]: updatedFood }));
    setSelectedFoodOption(newOption.name);
    setNewFoodOption({ name: '', description: '' });
    try {
      await api.put(`/events/options/${encodeURIComponent(formData.companyName)}`, { equipment: updatedEquipment, food: updatedFood });
    } catch (err) {
      console.warn('Could not save food options to server:', err.message);
    }
  };

  const removeFood = (index) => {
    const newFoodList = formData.logistics.food.filter((_, i) => i !== index);
    handleLogisticsChange('food', newFoodList);
  };

  const getSelectedAssetUsedQuantity = (assetId) => {
    return (formData.logistics.assetsUsed || [])
      .filter((asset) => String(asset.assetId) === String(assetId))
      .reduce((sum, asset) => sum + Number(asset.quantityUsed || 0), 0);
  };

  const selectedAsset = useMemo(
    () => availableAssets.find((row) => String(row._id) === String(selectedAssetId)) || null,
    [availableAssets, selectedAssetId]
  );

  const selectedAssetRemaining = useMemo(() => {
    if (!selectedAsset) return 0;
    const alreadyUsed = getSelectedAssetUsedQuantity(selectedAsset._id);
    return Math.max(0, Number(selectedAsset.totalCountAvailable || 0) - alreadyUsed);
  }, [selectedAsset, formData.logistics.assetsUsed]);

  const addAssetUsage = () => {
    if (!selectedAssetId) return;

    const asset = selectedAsset;
    if (!asset) return;

    const quantity = Number(selectedAssetQuantity || 1);
    if (quantity <= 0) return;

    const alreadyUsed = getSelectedAssetUsedQuantity(selectedAssetId);
    const remaining = Number(asset.totalCountAvailable || 0) - alreadyUsed;

    if (quantity > remaining) {
      alert('Selected quantity exceeds available units for this asset.');
      return;
    }

    const existingIndex = (formData.logistics.assetsUsed || []).findIndex(
      (row) => String(row.assetId) === String(selectedAssetId)
    );

    let nextAssetsUsed = [...(formData.logistics.assetsUsed || [])];

    if (existingIndex >= 0) {
      nextAssetsUsed[existingIndex] = {
        ...nextAssetsUsed[existingIndex],
        quantityUsed: Number(nextAssetsUsed[existingIndex].quantityUsed || 0) + quantity,
      };
    } else {
      nextAssetsUsed.push({
        assetId: asset._id,
        itemType: asset.itemType,
        unit: asset.unit,
        material: asset.material,
        unitPrice: asset.unitPrice,
        quantityUsed: quantity,
        totalPrice: Number(asset.unitPrice || 0) * quantity,
        placeOfStorage: asset.placeOfStorage,
        imageUrl: asset.imageUrl,
      });
    }

    nextAssetsUsed = nextAssetsUsed.map((row) => ({
      ...row,
      totalPrice: Number(row.unitPrice || 0) * Number(row.quantityUsed || 0),
    }));

    handleLogisticsChange('assetsUsed', nextAssetsUsed);
    setSelectedAssetId('');
    setSelectedAssetQuantity(1);
  };

  const removeAssetUsage = (assetId) => {
    const nextAssetsUsed = (formData.logistics.assetsUsed || []).filter(
      (row) => String(row.assetId) !== String(assetId)
    );
    handleLogisticsChange('assetsUsed', nextAssetsUsed);
  };

  const handleDisassemblyChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      disassembly: {
        ...prev.disassembly,
        [field]: value
      }
    }));
  };

  const handlePointOfContactChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      pointOfContact: {
        ...prev.pointOfContact,
        [field]: value
      }
    }));
  };

  const handleFlowerCollectionChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      flowerCollection: {
        ...prev.flowerCollection,
        [field]: value
      }
    }));
  };

  const handleFlowerImageUpload = async (file) => {
    if (!file) return;

    try {
      setIsUploadingFlowerImage(true);
      const uploadFormData = new FormData();
      uploadFormData.append('image', file);

      const response = await api.post('/upload/delivery-photo', uploadFormData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        },
        timeout: 30000
      });

      if (response.data?.url) {
        handleFlowerCollectionChange('pictureUrl', response.data.url);
      }
    } catch (error) {
      console.error('Flower image upload failed:', error);
      alert(error.response?.data?.message || 'Failed to upload flower picture');
    } finally {
      setIsUploadingFlowerImage(false);
    }
  };

  const handleNoPointOfContactToggle = (checked) => {
    setFormData((prev) => ({
      ...prev,
      pointOfContact: checked
        ? {
            noPointOfContact: true,
            name: '',
            phone: '',
            email: ''
          }
        : {
            ...prev.pointOfContact,
            noPointOfContact: false
          }
    }));
  };

  const handleDisassemblyRequirementChange = (isRequired) => {
    setFormData((prev) => ({
      ...prev,
      disassembly: {
        ...prev.disassembly,
        isRequired,
        date: isRequired ? prev.disassembly.date : '',
        arrivalTime: isRequired ? prev.disassembly.arrivalTime : '',
        disassemblyTime: isRequired ? prev.disassembly.disassemblyTime : '',
        notes: isRequired ? prev.disassembly.notes : ''
      }
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.eventName || !formData.eventDate || !formData.venue.address) {
      alert('Please fill in all required fields');
      return;
    }

    if (formData.companyName === 'Yellow Block') {
      const overLimitAsset = (formData.logistics.assetsUsed || []).find((usage) => {
        const matched = availableAssets.find((asset) => String(asset._id) === String(usage.assetId));
        if (!matched) return true;
        return Number(usage.quantityUsed || 0) > Number(matched.totalCountAvailable || 0);
      });
      if (overLimitAsset) {
        alert(`Asset usage for ${overLimitAsset.itemType || 'an asset'} exceeds available quantity.`);
        return;
      }
    }

    try {
      await dispatch(createEvent(formData)).unwrap();
      setFormData({
        eventName: '',
        companyName: defaultCompanyName,
        companyId: user?.profile?._id || '',
        companyLogo: companyOptions[0].logo,
        driverProvider: 'yellow_block',
        eventDate: '',
        emirate: 'Dubai',
        venue: {
          type: DEFAULT_VENUE_TYPES_BY_COMPANY[defaultCompanyName]?.[0] || '',
          address: '',
          area: '',
          googleMapsLink: ''
        },
        arrivalTime: '15:00',
        pointOfContact: {
          noPointOfContact: false,
          name: '',
          phone: '',
          email: ''
        },
        flowerCollection: {
          shopLocation: '',
          flowerCount: 1,
          pictureUrl: ''
        },
        logistics: {
          noLogisticsNeeded: false,
          numberOfPeople: 1,
          staffNames: [''],
          specialRequests: '',
          equipment: [],
          assetsUsed: [],
          food: []
        },
        disassembly: {
          isRequired: false,
          date: '',
          arrivalTime: '',
          disassemblyTime: '',
          notes: ''
        },
        isPaid: false,
        notes: ''
      });
      onClose();
    } catch (error) {
      const message = error?.error || error?.message || 'Failed to create event';
      console.error('Error creating event:', error);
      alert(message);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4 overflow-y-auto"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-white rounded-lg max-w-2xl w-full my-8"
          >
            {/* Header */}
            <div style={{
              background: `linear-gradient(to right, ${getCompanyColor(formData.companyName).bgFrom} 0%, ${getCompanyColor(formData.companyName).bgTo} 100%)`
            }} className="p-6 flex items-center justify-between">
              <h2 className="text-2xl font-bold text-white">Create New Event</h2>
              <button onClick={onClose} style={{ color: 'white' }} className="hover:opacity-80 p-1 rounded transition">
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="p-6 space-y-6 max-h-[calc(100vh-200px)] overflow-y-auto">
              {/* Company & Branding */}
              <div className="space-y-4 bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-lg border border-blue-200">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="w-5 h-5 bg-blue-600 text-white rounded-full text-xs flex items-center justify-center">0</span>
                  Company
                </h3>

                <div className="grid grid-cols-2 gap-4 items-center">
                  <div>
                    <label className="text-sm text-gray-600 block mb-2">Company *</label>
                    <select
                      value={formData.companyName}
                      onChange={(e) => {
                        const selected = companyOptions.find((c) => c.value === e.target.value);
                        setFormData((prev) => ({
                          ...prev,
                          companyName: selected.value,
                          companyLogo: selected.logo,
                          venue: {
                            ...prev.venue,
                            type: (venueTypesByCompany[selected.value] && venueTypesByCompany[selected.value].length > 0)
                              ? venueTypesByCompany[selected.value][0]
                              : (DEFAULT_VENUE_TYPES_BY_COMPANY[selected.value]?.[0] || '')
                          }
                        }));
                      }}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    >
                      {companyOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col items-start">
                    <label className="text-sm text-gray-600 block mb-2">Logo</label>
                    {formData.companyLogo ? (
                      <img
                        src={formData.companyLogo}
                        alt={formData.companyName}
                        className="w-12 h-12 object-contain border border-gray-200 rounded"
                      />
                    ) : (
                      <p className="text-xs text-gray-500">No logo available</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Assign driver: first field of a Yellow Block event */}
              {formData.companyName === 'Yellow Block' && (
                <div className="space-y-3 bg-pink-50 p-4 rounded-lg border border-pink-200">
                  <h3 className="font-semibold text-gray-900">Assign Driver *</h3>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { value: 'yellow_block', label: 'Yellow Block driver' },
                      { value: 'matter', label: 'Matter driver' }
                    ].map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex items-center gap-3 cursor-pointer rounded-lg px-3 py-2 border-2 bg-white ${
                          formData.driverProvider === opt.value ? 'border-blue-600' : 'border-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="driverProvider"
                          checked={formData.driverProvider === opt.value}
                          onChange={() => handleInputChange('driverProvider', opt.value)}
                          className="w-4 h-4"
                        />
                        <span className="text-gray-700 font-medium">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                  {formData.driverProvider === 'matter' && (
                    <p className="text-xs text-blue-700">This event will be delivered by a Matter driver and shown pink and blue on the calendar.</p>
                  )}
                </div>
              )}

              {/* Basic Info */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="w-5 h-5 bg-blue-600 text-white rounded-full text-xs flex items-center justify-center">1</span>
                  Basic Information
                </h3>

                <div className="grid grid-cols-2 gap-4">
                  <input
                    type="text"
                    placeholder="Event Name *"
                    value={formData.eventName}
                    onChange={(e) => handleInputChange('eventName', e.target.value)}
                    className="col-span-2 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />

                  <input
                    type="date"
                    value={formData.eventDate}
                    onChange={(e) => handleInputChange('eventDate', e.target.value)}
                    className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />

                  <input
                    type="time"
                    value={formData.arrivalTime}
                    onChange={(e) => handleInputChange('arrivalTime', e.target.value)}
                    className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              {/* Venue Info */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="w-5 h-5 bg-blue-600 text-white rounded-full text-xs flex items-center justify-center">2</span>
                  Venue Information
                </h3>

                <select
                  value={formData.emirate}
                  onChange={(e) => handleInputChange('emirate', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {emirates.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>

                <select
                  value={formData.venue.type}
                  onChange={(e) => handleVenueChange('type', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {venueTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>

                {formData.venue.type === 'Other' && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Add venue"
                      value={newVenueType}
                      onChange={(e) => setNewVenueType(e.target.value)}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={handleAddVenueType}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                    >
                      Add Venue
                    </button>
                  </div>
                )}

                <input
                  type="text"
                  placeholder="Area/Neighborhood *"
                  value={formData.venue.area}
                  onChange={(e) => handleVenueChange('area', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />

                <textarea
                  placeholder="Full Address *"
                  value={formData.venue.address}
                  onChange={(e) => handleVenueChange('address', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows="2"
                  required
                ></textarea>

                <input
                  type="url"
                  placeholder="Google Maps Link (optional)"
                  value={formData.venue.googleMapsLink}
                  onChange={(e) => handleVenueChange('googleMapsLink', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Point of Contact */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="w-5 h-5 bg-blue-600 text-white rounded-full text-xs flex items-center justify-center">3</span>
                  Point of Contact
                </h3>

                <label className="flex items-center gap-3 cursor-pointer border border-gray-300 rounded-lg px-3 py-2">
                  <input
                    type="checkbox"
                    checked={!!formData.pointOfContact?.noPointOfContact}
                    onChange={(e) => handleNoPointOfContactToggle(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span className="text-gray-700 font-medium">No point of contact</span>
                </label>

                {!formData.pointOfContact?.noPointOfContact && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <input
                      type="text"
                      placeholder="Contact Name"
                      value={formData.pointOfContact?.name || ''}
                      onChange={(e) => handlePointOfContactChange('name', e.target.value)}
                      className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <input
                      type="tel"
                      placeholder="Contact Phone"
                      value={formData.pointOfContact?.phone || ''}
                      onChange={(e) => handlePointOfContactChange('phone', e.target.value)}
                      className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <input
                      type="email"
                      placeholder="Contact Email"
                      value={formData.pointOfContact?.email || ''}
                      onChange={(e) => handlePointOfContactChange('email', e.target.value)}
                      className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                )}
              </div>

              {/* Logistics */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="w-5 h-5 bg-blue-600 text-white rounded-full text-xs flex items-center justify-center">4</span>
                  Logistics & Equipment
                </h3>

                <label className="flex items-center gap-3 cursor-pointer bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  <input
                    type="checkbox"
                    checked={!!formData.logistics.noLogisticsNeeded}
                    onChange={(e) => handleNoLogisticsToggle(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm font-medium text-orange-800">No logistics needed</span>
                </label>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-gray-600 block mb-2">Number of People</label>
                    <input
                      type="number"
                      min="1"
                      value={formData.logistics.numberOfPeople}
                      onChange={(e) => handleLogisticsChange('numberOfPeople', parseInt(e.target.value))}
                      disabled={!!formData.logistics.noLogisticsNeeded}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm text-gray-600 block mb-2">Staff Names</label>
                  <div className="space-y-2">
                    {formData.logistics.staffNames.map((name, index) => (
                      <div key={index} className="flex gap-2">
                        <input
                          type="text"
                          placeholder={`Staff member ${index + 1}`}
                          value={name}
                          onChange={(e) => handleStaffNameChange(index, e.target.value)}
                          disabled={!!formData.logistics.noLogisticsNeeded}
                          className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        {formData.logistics.staffNames.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeStaffName(index)}
                            className="px-3 py-2 bg-red-50 text-red-600 rounded border border-red-200 hover:bg-red-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={addStaffName}
                      disabled={!!formData.logistics.noLogisticsNeeded}
                      className="text-sm text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1"
                    >
                      <Plus className="w-4 h-4" />
                      Add Staff Member
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-sm text-gray-600 block mb-2">Special Requests</label>
                  <textarea
                    placeholder="Any special requests or instructions"
                    value={formData.logistics.specialRequests}
                    onChange={(e) => handleLogisticsChange('specialRequests', e.target.value)}
                    disabled={!!formData.logistics.noLogisticsNeeded}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    rows="3"
                  ></textarea>
                </div>

                {/* Equipment Section */}
                <div className="bg-gray-50 p-4 rounded-lg">
                  <h4 className="font-semibold text-gray-900 mb-3">Equipment</h4>

                  {formData.logistics.equipment.length > 0 && (
                    <div className="space-y-2 mb-4">
                      {formData.logistics.equipment.map((item, index) => (
                        <div key={index} className="bg-white p-3 rounded border border-gray-200 flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-gray-900">{item.name}</p>
                            <p className="text-xs text-gray-600">
                              {item.dimensions && `${item.dimensions}`} {item.quantity > 1 && `× ${item.quantity}`}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeEquipment(index)}
                            className="p-2 bg-red-50 text-red-600 rounded hover:bg-red-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="space-y-3">
                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Select Equipment</label>
                      <select
                        value={selectedEquipmentOption}
                        onChange={(e) => setSelectedEquipmentOption(e.target.value)}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">-- Choose Equipment --</option>
                        {currentEquipmentOptions.map((equip) => (
                          <option key={equip.name} value={equip.name}>
                            {equip.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="1"
                        placeholder="Quantity"
                        value={newEquipment.quantity}
                        onChange={(e) => setNewEquipment({ ...newEquipment, quantity: parseInt(e.target.value) || 1 })}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-20 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <button
                        type="button"
                        onClick={addEquipment}
                        disabled={!!formData.logistics.noLogisticsNeeded || !selectedEquipmentOption}
                        className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition font-semibold flex items-center justify-center gap-2 disabled:bg-gray-400"
                      >
                        <Plus className="w-4 h-4" />
                        Add Equipment
                      </button>
                    </div>

                    {/* Add New Equipment Option */}
                    <div className="border-t pt-3 mt-3">
                      <p className="text-xs text-gray-600 mb-2 font-semibold">Add New Equipment Type</p>
                      <input
                        type="text"
                        placeholder="Equipment name (e.g., Projector)"
                        value={newEquipmentOption.name}
                        onChange={(e) => setNewEquipmentOption({ ...newEquipmentOption, name: e.target.value })}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                      />
                      <input
                        type="text"
                        placeholder="Dimensions (optional)"
                        value={newEquipmentOption.dimensions}
                        onChange={(e) => setNewEquipmentOption({ ...newEquipmentOption, dimensions: e.target.value })}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                      />
                      <button
                        type="button"
                        onClick={addNewEquipmentOption}
                        disabled={!!formData.logistics.noLogisticsNeeded || !newEquipmentOption.name.trim()}
                        className="w-full bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition font-semibold flex items-center justify-center gap-2 disabled:bg-gray-400"
                      >
                        <Plus className="w-4 h-4" />
                        Create New Equipment Type
                      </button>
                    </div>
                  </div>
                </div>

                {/* Food Section */}
                <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                  <h4 className="font-semibold text-gray-900 mb-3">Food Items</h4>

                  {formData.logistics.food.length > 0 && (
                    <div className="space-y-2 mb-4">
                      {formData.logistics.food.map((item, index) => (
                        <div key={index} className="bg-white p-3 rounded border border-blue-200 flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-gray-900">{item.name}</p>
                            <p className="text-xs text-gray-600">
                              {item.description && `${item.description}`} {item.quantity > 1 && `× ${item.quantity}`}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeFood(index)}
                            className="p-2 bg-red-50 text-red-600 rounded hover:bg-red-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="space-y-3">
                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Select Food</label>
                      <select
                        value={selectedFoodOption}
                        onChange={(e) => setSelectedFoodOption(e.target.value)}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">-- Choose Food --</option>
                        {currentFoodOptions.map((food) => (
                          <option key={food.name} value={food.name}>
                            {food.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="1"
                        placeholder="Quantity"
                        value={newFood.quantity}
                        onChange={(e) => setNewFood({ ...newFood, quantity: parseInt(e.target.value) || 1 })}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-20 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <button
                        type="button"
                        onClick={addFood}
                        disabled={!!formData.logistics.noLogisticsNeeded || !selectedFoodOption}
                        className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition font-semibold flex items-center justify-center gap-2 disabled:bg-gray-400"
                      >
                        <Plus className="w-4 h-4" />
                        Add Food
                      </button>
                    </div>

                    {/* Add New Food Option */}
                    <div className="border-t pt-3 mt-3">
                      <p className="text-xs text-gray-600 mb-2 font-semibold">Add New Food Type</p>
                      <input
                        type="text"
                        placeholder="Food name (e.g., Catering Tray)"
                        value={newFoodOption.name}
                        onChange={(e) => setNewFoodOption({ ...newFoodOption, name: e.target.value })}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                      />
                      <input
                        type="text"
                        placeholder="Description (e.g., 8 servings)"
                        value={newFoodOption.description}
                        onChange={(e) => setNewFoodOption({ ...newFoodOption, description: e.target.value })}
                        disabled={!!formData.logistics.noLogisticsNeeded}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                      />
                      <button
                        type="button"
                        onClick={addNewFoodOption}
                        disabled={!!formData.logistics.noLogisticsNeeded || !newFoodOption.name.trim()}
                        className="w-full bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition font-semibold flex items-center justify-center gap-2 disabled:bg-gray-400"
                      >
                        <Plus className="w-4 h-4" />
                        Create New Food Type
                      </button>
                    </div>
                  </div>
                </div>

                {formData.companyName === 'Yellow Block' && (
                  <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
                    <h4 className="font-semibold text-gray-900 mb-3">Asset Usage (Yellow Block)</h4>

                    {(formData.logistics.assetsUsed || []).length > 0 && (
                      <div className="space-y-2 mb-4">
                        {(formData.logistics.assetsUsed || []).map((assetUsage) => (
                          <div key={String(assetUsage.assetId)} className="bg-white p-3 rounded border border-purple-200 flex items-center justify-between">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-11 h-11 rounded-lg overflow-hidden bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
                                {assetUsage.imageUrl ? (
                                  <img src={assetUsage.imageUrl} alt={assetUsage.itemType} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-5 h-5 rounded bg-purple-100" />
                                )}
                              </div>
                              <div>
                                <p className="font-semibold text-gray-900">{assetUsage.itemType}</p>
                                <p className="text-xs text-gray-600">
                                  {assetUsage.quantityUsed} {assetUsage.unit} · {assetUsage.placeOfStorage || 'No storage'}
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeAssetUsage(assetUsage.assetId)}
                              className="p-2 bg-red-50 text-red-600 rounded hover:bg-red-100"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="space-y-3">
                      <div>
                        <label className="text-sm text-gray-600 block mb-2">Select Asset</label>
                        <select
                          value={selectedAssetId}
                          onChange={(e) => {
                            setSelectedAssetId(e.target.value);
                            setSelectedAssetQuantity(1);
                          }}
                          disabled={!!formData.logistics.noLogisticsNeeded}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        >
                          <option value="">-- Choose Asset --</option>
                          {availableAssets.map((asset) => (
                            <option key={asset._id} value={asset._id}>
                              {asset.itemType} ({asset.material || 'N/A'}) - Available: {asset.totalCountAvailable}
                            </option>
                          ))}
                        </select>
                      </div>

                      {selectedAsset && (
                        <div className="bg-white border border-purple-200 rounded-lg p-3 flex items-center gap-3">
                          <div className="w-14 h-14 rounded-lg overflow-hidden bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
                            {selectedAsset.imageUrl ? (
                              <img src={selectedAsset.imageUrl} alt={selectedAsset.itemType} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-6 h-6 rounded bg-purple-100" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900">{selectedAsset.itemType}</p>
                            <p className="text-xs text-gray-600">
                              {selectedAsset.material || 'N/A'} · {selectedAsset.unit} · {selectedAsset.placeOfStorage || 'No storage'}
                            </p>
                            <p className="text-xs text-purple-700 font-semibold">
                              Remaining for this event: {selectedAssetRemaining} {selectedAsset.unit}
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2">
                        <input
                          type="number"
                          min="1"
                          max={Math.max(1, selectedAssetRemaining)}
                          placeholder="Units"
                          value={selectedAssetQuantity}
                          onChange={(e) => {
                            const next = parseInt(e.target.value, 10) || 1;
                            const bounded = selectedAsset ? Math.min(next, Math.max(1, selectedAssetRemaining)) : next;
                            setSelectedAssetQuantity(Math.max(1, bounded));
                          }}
                          disabled={!!formData.logistics.noLogisticsNeeded || (selectedAsset ? selectedAssetRemaining <= 0 : false)}
                          className="w-24 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                        <button
                          type="button"
                          onClick={addAssetUsage}
                          disabled={
                            !!formData.logistics.noLogisticsNeeded ||
                            !selectedAssetId ||
                            !selectedAsset ||
                            selectedAssetRemaining <= 0 ||
                            Number(selectedAssetQuantity || 0) > selectedAssetRemaining
                          }
                          className="flex-1 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition font-semibold flex items-center justify-center gap-2 disabled:bg-gray-400"
                        >
                          <Plus className="w-4 h-4" />
                          Add Asset Usage
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {formData.companyName === 'Yellow Block' && (
                <div className="space-y-4 border-t pt-4">
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <span className="w-5 h-5 bg-pink-600 text-white rounded-full text-xs flex items-center justify-center">5</span>
                    Flower Collection
                  </h3>

                  <div className="bg-pink-50 p-4 rounded-lg border border-pink-200 space-y-4">
                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Flower Shop Location</label>
                      <input
                        type="text"
                        placeholder="Enter flower shop location"
                        value={formData.flowerCollection.shopLocation}
                        onChange={(e) => handleFlowerCollectionChange('shopLocation', e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-500"
                      />
                    </div>

                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Number of Flowers</label>
                      <input
                        type="number"
                        min="1"
                        value={formData.flowerCollection.flowerCount}
                        onChange={(e) => handleFlowerCollectionChange('flowerCount', parseInt(e.target.value, 10) || 1)}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-500"
                      />
                    </div>

                    <div>
                      <label className="text-sm text-gray-600 block mb-2">Flower Picture</label>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => handleFlowerImageUpload(e.target.files?.[0])}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-500 file:mr-4 file:rounded file:border-0 file:bg-pink-100 file:px-3 file:py-2 file:text-pink-700"
                      />
                      {isUploadingFlowerImage && (
                        <p className="text-sm text-pink-600 mt-2">Uploading picture...</p>
                      )}
                      {formData.flowerCollection.pictureUrl && (
                        <div className="mt-3">
                          <img
                            src={formData.flowerCollection.pictureUrl}
                            alt="Flower collection"
                            className="w-32 h-32 object-cover rounded-lg border border-pink-200"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Disassembly */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <span className="w-5 h-5 bg-blue-600 text-white rounded-full text-xs flex items-center justify-center">6</span>
                  Disassembly
                </h3>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-center gap-3 cursor-pointer border border-gray-300 rounded-lg px-3 py-2">
                    <input
                      type="radio"
                      name="disassemblyRequirement"
                      checked={formData.disassembly.isRequired === true}
                      onChange={() => handleDisassemblyRequirementChange(true)}
                      className="w-4 h-4"
                    />
                    <span className="text-gray-700 font-medium">Required</span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer border border-gray-300 rounded-lg px-3 py-2">
                    <input
                      type="radio"
                      name="disassemblyRequirement"
                      checked={formData.disassembly.isRequired === false}
                      onChange={() => handleDisassemblyRequirementChange(false)}
                      className="w-4 h-4"
                    />
                    <span className="text-gray-700 font-medium">Not Required</span>
                  </label>
                </div>

                {formData.disassembly.isRequired && (
                  <div className="grid grid-cols-2 gap-4 bg-blue-50 p-4 rounded-lg">
                    <input
                      type="date"
                      value={formData.disassembly.date}
                      onChange={(e) => handleDisassemblyChange('date', e.target.value)}
                      className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <input
                      type="time"
                      placeholder="Driver Arrival Time"
                      value={formData.disassembly.arrivalTime}
                      onChange={(e) => handleDisassemblyChange('arrivalTime', e.target.value)}
                      className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <input
                      type="time"
                      placeholder="Disassembly Time"
                      value={formData.disassembly.disassemblyTime}
                      onChange={(e) => handleDisassemblyChange('disassemblyTime', e.target.value)}
                      className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <textarea
                      placeholder="Special notes for disassembly"
                      value={formData.disassembly.notes}
                      onChange={(e) => handleDisassemblyChange('notes', e.target.value)}
                      className="col-span-2 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      rows="2"
                    ></textarea>
                  </div>
                )}
              </div>

              {/* Payment Status - Matter only */}
              {isMatter && (
                <div className="border-t pt-4">
                  <label className="text-sm font-semibold text-gray-700 block mb-2">Payment Status</label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => handleInputChange('isPaid', true)}
                      className={`flex-1 py-2 rounded-lg border-2 font-semibold text-sm transition ${
                        formData.isPaid
                          ? 'bg-green-600 border-green-600 text-white'
                          : 'border-gray-300 text-gray-500 hover:border-green-400'
                      }`}
                    >
                      Paid
                    </button>
                    <button
                      type="button"
                      onClick={() => handleInputChange('isPaid', false)}
                      className={`flex-1 py-2 rounded-lg border-2 font-semibold text-sm transition ${
                        !formData.isPaid
                          ? 'bg-red-500 border-red-500 text-white'
                          : 'border-gray-300 text-gray-500 hover:border-red-400'
                      }`}
                    >
                      Not Paid
                    </button>
                  </div>
                </div>
              )}

              {/* Additional Notes */}
              <div className="border-t pt-4">
                <label className="text-sm text-gray-600 block mb-2">Additional Notes</label>
                <textarea
                  placeholder="Any other important information"
                  value={formData.notes}
                  onChange={(e) => handleInputChange('notes', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows="3"
                ></textarea>
              </div>

              {/* Submit */}
              <div className="flex gap-4 pt-4 border-t">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 px-6 py-3 border border-gray-300 rounded-lg text-gray-700 font-semibold hover:bg-gray-50 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Creating...' : 'Create Event'}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default CreateEventModal;
