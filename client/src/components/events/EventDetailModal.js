import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { updateEvent } from '../../store/slices/eventSlice';
import { X, MapPin, Calendar, Clock, Users, ExternalLink, Edit2, Check, AlertTriangle, MessageCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import jsPDF from 'jspdf';

const EventDetailModal = ({ isOpen, onClose }) => {
  const dispatch = useDispatch();
  const { selectedEvent } = useSelector((state) => state.events);
  const { isLoading } = useSelector((state) => state.events);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState(selectedEvent || {});
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [newFoodItem, setNewFoodItem] = useState({ name: '', quantity: 1 });
  const [isSharingFoodPdf, setIsSharingFoodPdf] = useState(false);

  useEffect(() => {
    if (selectedEvent) {
      setEditData({
        ...selectedEvent,
        venue: {
          type: selectedEvent.venue?.type || '',
          area: selectedEvent.venue?.area || '',
          address: selectedEvent.venue?.address || '',
          googleMapsLink: selectedEvent.venue?.googleMapsLink || ''
        },
        pointOfContact: {
          noPointOfContact: !!selectedEvent.pointOfContact?.noPointOfContact,
          name: selectedEvent.pointOfContact?.name || '',
          phone: selectedEvent.pointOfContact?.phone || '',
          email: selectedEvent.pointOfContact?.email || ''
        },
        flowerCollection: {
          shopLocation: selectedEvent.flowerCollection?.shopLocation || '',
          flowerCount: selectedEvent.flowerCollection?.flowerCount || 1,
          pictureUrl: selectedEvent.flowerCollection?.pictureUrl || ''
        },
        logistics: {
          noLogisticsNeeded: !!selectedEvent.logistics?.noLogisticsNeeded,
          numberOfPeople: selectedEvent.logistics?.numberOfPeople || 1,
          staffNames: Array.isArray(selectedEvent.logistics?.staffNames) ? selectedEvent.logistics.staffNames : [],
          specialRequests: selectedEvent.logistics?.specialRequests || '',
          equipment: Array.isArray(selectedEvent.logistics?.equipment) ? selectedEvent.logistics.equipment : [],
          assetsUsed: Array.isArray(selectedEvent.logistics?.assetsUsed) ? selectedEvent.logistics.assetsUsed : [],
          food: Array.isArray(selectedEvent.logistics?.food) ? selectedEvent.logistics.food : []
        },
        disassembly: {
          isRequired: !!selectedEvent.disassembly?.isRequired,
          date: selectedEvent.disassembly?.date ? String(selectedEvent.disassembly.date).slice(0, 10) : '',
          arrivalTime: selectedEvent.disassembly?.arrivalTime || '',
          disassemblyTime: selectedEvent.disassembly?.disassemblyTime || '',
          notes: selectedEvent.disassembly?.notes || ''
        },
        notes: selectedEvent.notes || ''
      });
    }
  }, [selectedEvent]);

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

  if (!selectedEvent) return null;

  const handleStatusChange = (newStatus) => {
    dispatch(updateEvent({ id: selectedEvent._id, data: { status: newStatus } }));
  };

  const handleCancelEvent = async () => {
    await dispatch(updateEvent({ id: selectedEvent._id, data: { status: 'cancelled' } }));
    setShowCancelConfirm(false);
  };

  const handleEditStart = () => {
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    if (selectedEvent) {
      setEditData({
        ...selectedEvent,
        venue: {
          type: selectedEvent.venue?.type || '',
          area: selectedEvent.venue?.area || '',
          address: selectedEvent.venue?.address || '',
          googleMapsLink: selectedEvent.venue?.googleMapsLink || ''
        },
        pointOfContact: {
          noPointOfContact: !!selectedEvent.pointOfContact?.noPointOfContact,
          name: selectedEvent.pointOfContact?.name || '',
          phone: selectedEvent.pointOfContact?.phone || '',
          email: selectedEvent.pointOfContact?.email || ''
        },
        flowerCollection: {
          shopLocation: selectedEvent.flowerCollection?.shopLocation || '',
          flowerCount: selectedEvent.flowerCollection?.flowerCount || 1,
          pictureUrl: selectedEvent.flowerCollection?.pictureUrl || ''
        },
        logistics: {
          noLogisticsNeeded: !!selectedEvent.logistics?.noLogisticsNeeded,
          numberOfPeople: selectedEvent.logistics?.numberOfPeople || 1,
          staffNames: Array.isArray(selectedEvent.logistics?.staffNames) ? selectedEvent.logistics.staffNames : [],
          specialRequests: selectedEvent.logistics?.specialRequests || '',
          equipment: Array.isArray(selectedEvent.logistics?.equipment) ? selectedEvent.logistics.equipment : [],
          assetsUsed: Array.isArray(selectedEvent.logistics?.assetsUsed) ? selectedEvent.logistics.assetsUsed : [],
          food: Array.isArray(selectedEvent.logistics?.food) ? selectedEvent.logistics.food : []
        },
        disassembly: {
          isRequired: !!selectedEvent.disassembly?.isRequired,
          date: selectedEvent.disassembly?.date ? String(selectedEvent.disassembly.date).slice(0, 10) : '',
          arrivalTime: selectedEvent.disassembly?.arrivalTime || '',
          disassemblyTime: selectedEvent.disassembly?.disassemblyTime || '',
          notes: selectedEvent.disassembly?.notes || ''
        },
        notes: selectedEvent.notes || ''
      });
    }
  };

  const handleSaveEdit = async () => {
    await dispatch(updateEvent({ id: selectedEvent._id, data: editData }));
    setIsEditing(false);
    setNewFoodItem({ name: '', quantity: 1 });
  };

  const handleFieldChange = (field, value) => {
    setEditData((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const handleNestedChange = (parent, field, value) => {
    setEditData((prev) => ({
      ...prev,
      [parent]: {
        ...prev[parent],
        [field]: value
      }
    }));
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const statusColors = {
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    assigned: 'bg-blue-50 text-blue-700 border-blue-200',
    in_progress: 'bg-purple-50 text-purple-700 border-purple-200',
    completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    cancelled: 'bg-red-50 text-red-700 border-red-200'
  };

  const buildEventFoodPdfBlob = () => {
    const eventData = isEditing ? editData : selectedEvent;
    const foodItems = eventData?.logistics?.food || [];

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = 210;
    const margin = 14;
    const contentWidth = pageWidth - (margin * 2);
    let y = 18;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Event Food Items', margin, y);

    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.text(`Event: ${String(eventData?.eventName || '-')}`, margin, y);
    y += 6;
    doc.text(`Company: ${String(eventData?.companyName || '-')}`, margin, y);
    y += 6;
    doc.text(`Date: ${formatDate(eventData?.eventDate)}`, margin, y);
    y += 6;
    doc.text(`Location: ${String(eventData?.venue?.address || '-')}`, margin, y);
    y += 8;

    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;

    if (foodItems.length === 0) {
      doc.setFontSize(11);
      doc.text('No food items recorded for this event.', margin, y);
    } else {
      foodItems.forEach((item, index) => {
        if (y > 270) {
          doc.addPage();
          y = 18;
        }

        const itemName = String(item?.name || 'Unnamed item');
        const quantity = Number(item?.quantity || 1);
        const description = String(item?.description || '').trim();

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        const titleLines = doc.splitTextToSize(`${index + 1}. ${itemName}`, contentWidth);
        doc.text(titleLines, margin, y);
        y += titleLines.length * 5;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.text(`Quantity: ${quantity}`, margin, y);
        y += 5;

        if (description) {
          const descLines = doc.splitTextToSize(`Description: ${description}`, contentWidth);
          doc.text(descLines, margin, y);
          y += descLines.length * 5;
        }

        y += 3;
      });
    }

    return doc.output('blob');
  };

  const handleShareFoodItemsWhatsApp = async () => {
    const eventData = isEditing ? editData : selectedEvent;
    const foodItems = eventData?.logistics?.food || [];

    if (!foodItems.length) {
      alert('No food items found for this event.');
      return;
    }

    try {
      setIsSharingFoodPdf(true);
      const pdfBlob = buildEventFoodPdfBlob();
      const safeEventName = String(eventData?.eventName || 'event').replace(/[^a-z0-9]+/gi, '_');
      const fileName = `${safeEventName}_food_items.pdf`;
      const file = new File([pdfBlob], fileName, { type: 'application/pdf' });
      const shareText = `Food items for ${eventData?.eventName || 'event'}`;

      // On mobile devices, native share usually includes WhatsApp directly.
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        await navigator.share({
          files: [file],
          title: 'Event Food Items',
          text: shareText
        });
        return;
      }

      // Desktop fallback: download PDF then open WhatsApp chat text.
      const objectUrl = URL.createObjectURL(pdfBlob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      const waText = encodeURIComponent(`${shareText}\n\nThe PDF has been downloaded. Please attach it in WhatsApp.`);
      window.open(`https://wa.me/?text=${waText}`, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    } catch (error) {
      console.error('Error sharing food items PDF:', error);
      alert('Failed to share food items. Please try again.');
    } finally {
      setIsSharingFoodPdf(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black bg-opacity-50 z-[9999] flex items-center justify-center p-4 overflow-y-auto"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-white rounded-lg max-w-3xl w-full my-8 relative"
          >
            {/* Header */}
            <div style={{
              background: (selectedEvent.companyName === 'Yellow Block' && selectedEvent.driverProvider === 'matter')
                ? 'linear-gradient(to right, #f0a3ed 0%, #f0a3ed 50%, #2563eb 50%, #2563eb 100%)'
                : `linear-gradient(to right, ${getCompanyColor(selectedEvent.companyName).bgFrom} 0%, ${getCompanyColor(selectedEvent.companyName).bgTo} 100%)`
            }} className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                {selectedEvent.companyLogo ? (
                  <div className={`w-16 h-16 rounded border-2 border-white/80 p-2 shadow-md overflow-hidden flex-shrink-0 ${selectedEvent.companyName?.toLowerCase().includes('matter') ? 'bg-blue-600' : 'bg-white/95'}`}>
                    <img
                      src={selectedEvent.companyLogo}
                      alt={selectedEvent.companyName}
                      className="w-full h-full object-contain"
                    />
                  </div>
                ) : (
                  <div className={`w-16 h-16 rounded border-2 border-white/80 shadow-md flex items-center justify-center font-bold text-xl flex-shrink-0 ${selectedEvent.companyName?.toLowerCase().includes('matter') ? 'bg-blue-600 text-white' : 'bg-white/95 text-gray-700'}`}>
                    {selectedEvent.companyName?.charAt(0) || 'C'}
                  </div>
                )}
                <div>
                  <h2 className="text-2xl font-bold text-white">{selectedEvent.eventName}</h2>
                  <p style={{ color: getCompanyColor(selectedEvent.companyName).light }} className="opacity-90">{selectedEvent.companyName}</p>
                </div>
              </div>
              <button onClick={onClose} style={{ color: 'white' }} className="hover:opacity-80 p-1 rounded transition">
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-6 max-h-[calc(100vh-200px)] overflow-y-auto">
              {/* Status Bar */}
              <div className="flex items-center gap-4">
                <div className={`px-4 py-2 rounded-lg border font-semibold text-sm ${statusColors[selectedEvent.status]}`}>
                  {selectedEvent.status.replace('_', ' ').toUpperCase()}
                </div>
                {selectedEvent.companyName === 'Yellow Block' && selectedEvent.driverProvider === 'matter' && (
                  <div className="px-4 py-2 rounded-lg border border-blue-300 bg-blue-50 text-blue-800 font-semibold text-sm">
                    🚚 Delivered by Matter driver
                  </div>
                )}
                {!isEditing && (
                  <div className="flex gap-2 ml-auto flex-wrap">
                    <button
                      onClick={handleShareFoodItemsWhatsApp}
                      disabled={isSharingFoodPdf}
                      className="px-3 py-1 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:bg-gray-100 disabled:text-gray-400 inline-flex items-center gap-1"
                    >
                      <MessageCircle className="w-4 h-4" />
                      {isSharingFoodPdf ? 'Preparing...' : 'Share Food PDF'}
                    </button>
                    <button
                      onClick={handleEditStart}
                      disabled={selectedEvent.status === 'cancelled'}
                      className="px-3 py-1 text-sm bg-white text-gray-700 rounded hover:bg-gray-100 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Edit2 className="w-4 h-4" />
                      Edit
                    </button>
                    <button
                      onClick={() => handleStatusChange('assigned')}
                      disabled={selectedEvent.status === 'assigned' || selectedEvent.status === 'cancelled'}
                      className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:bg-gray-100 disabled:text-gray-400"
                    >
                      Assign
                    </button>
                    <button
                      onClick={() => handleStatusChange('in_progress')}
                      disabled={selectedEvent.status === 'in_progress' || selectedEvent.status === 'cancelled'}
                      className="px-3 py-1 text-sm bg-purple-100 text-purple-700 rounded hover:bg-purple-200 disabled:bg-gray-100 disabled:text-gray-400"
                    >
                      In Progress
                    </button>
                    <button
                      onClick={() => handleStatusChange('completed')}
                      disabled={selectedEvent.status === 'cancelled'}
                      className="px-3 py-1 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:bg-gray-100 disabled:text-gray-400"
                    >
                      Complete
                    </button>
                    {selectedEvent.status !== 'cancelled' && (
                      <button
                        onClick={() => setShowCancelConfirm(true)}
                        className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 inline-flex items-center gap-1"
                      >
                        <AlertTriangle className="w-4 h-4" />
                        Cancel Event
                      </button>
                    )}
                    {selectedEvent.status === 'cancelled' && (
                      <button
                        onClick={() => handleStatusChange('pending')}
                        className="px-3 py-1 text-sm bg-amber-100 text-amber-700 rounded hover:bg-amber-200"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                )}
                {isEditing && (
                  <div className="flex gap-2 ml-auto">
                    <button
                      onClick={handleCancelEdit}
                      className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      disabled={isLoading}
                      className="px-3 py-1 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200 inline-flex items-center gap-1 disabled:bg-gray-100 disabled:text-gray-400"
                    >
                      <Check className="w-4 h-4" />
                      Save
                    </button>
                  </div>
                )}
              </div>

              {/* Date & Time */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                  <div className="flex items-center gap-2 mb-2">
                    <Calendar className="w-5 h-5 text-blue-600" />
                    <span className="font-semibold text-gray-700">Event Date</span>
                  </div>
                  {isEditing ? (
                    <input
                      type="date"
                      value={editData.eventDate ? String(editData.eventDate).slice(0, 10) : ''}
                      onChange={(e) => handleFieldChange('eventDate', e.target.value)}
                      className="w-full px-3 py-2 border border-blue-200 rounded-lg"
                    />
                  ) : (
                    <p className="text-lg font-bold text-gray-900">{formatDate(selectedEvent.eventDate)}</p>
                  )}
                </div>

                <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-5 h-5 text-green-600" />
                    <span className="font-semibold text-gray-700">Arrival Time</span>
                  </div>
                  {isEditing ? (
                    <input
                      type="time"
                      value={editData.arrivalTime || ''}
                      onChange={(e) => handleFieldChange('arrivalTime', e.target.value)}
                      className="w-full px-3 py-2 border border-green-200 rounded-lg"
                    />
                  ) : (
                    <p className="text-lg font-bold text-gray-900">{selectedEvent.arrivalTime}</p>
                  )}
                </div>
              </div>

              {/* Location */}
              <div className="bg-red-50 p-4 rounded-lg border border-red-200">
                <div className="flex items-center gap-2 mb-3">
                  <MapPin className="w-5 h-5 text-red-600" />
                  <span className="font-semibold text-gray-900">Venue Location</span>
                </div>
                <div className="space-y-2">
                  <div>
                    <p className="text-sm text-gray-600">Emirate</p>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editData.emirate || ''}
                        onChange={(e) => handleFieldChange('emirate', e.target.value)}
                        className="w-full px-3 py-2 border border-red-200 rounded-lg"
                      />
                    ) : (
                      <p className="font-semibold text-gray-900">{selectedEvent.emirate}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Area</p>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editData.venue?.area || ''}
                        onChange={(e) => handleNestedChange('venue', 'area', e.target.value)}
                        className="w-full px-3 py-2 border border-red-200 rounded-lg"
                      />
                    ) : (
                      <p className="font-semibold text-gray-900">{selectedEvent.venue.area}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Venue Type</p>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editData.venue?.type || ''}
                        onChange={(e) => handleNestedChange('venue', 'type', e.target.value)}
                        className="w-full px-3 py-2 border border-red-200 rounded-lg"
                      />
                    ) : (
                      <p className="font-semibold text-gray-900">{selectedEvent.venue.type}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Address</p>
                    {isEditing ? (
                      <textarea
                        value={editData.venue?.address || ''}
                        onChange={(e) => handleNestedChange('venue', 'address', e.target.value)}
                        className="w-full px-3 py-2 border border-red-200 rounded-lg"
                        rows={2}
                      />
                    ) : (
                      <p className="font-semibold text-gray-900">{selectedEvent.venue.address}</p>
                    )}
                  </div>
                  {(selectedEvent.venue.googleMapsLink || isEditing) && (
                    <a
                      href={selectedEvent.venue.googleMapsLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 mt-2"
                    >
                      {isEditing ? (
                        <input
                          type="url"
                          value={editData.venue?.googleMapsLink || ''}
                          onChange={(e) => handleNestedChange('venue', 'googleMapsLink', e.target.value)}
                          className="w-full min-w-[320px] px-3 py-2 border border-red-200 rounded-lg"
                          placeholder="Google Maps Link"
                        />
                      ) : (
                        <>
                          <ExternalLink className="w-4 h-4" />
                          View on Google Maps
                        </>
                      )}
                    </a>
                  )}
                </div>
              </div>

              {/* Point of Contact */}
              {(selectedEvent.pointOfContact?.noPointOfContact || selectedEvent.pointOfContact?.name || selectedEvent.pointOfContact?.phone || selectedEvent.pointOfContact?.email || isEditing) && (
                <div className="bg-indigo-50 p-4 rounded-lg border border-indigo-200">
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-5 h-5 text-indigo-600" />
                    <span className="font-semibold text-gray-900">Point of Contact</span>
                  </div>
                  <div className="space-y-2">
                    {isEditing ? (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={!!editData.pointOfContact?.noPointOfContact}
                          onChange={(e) => handleNestedChange('pointOfContact', 'noPointOfContact', e.target.checked)}
                        />
                        <span className="text-sm text-gray-700">No point of contact</span>
                      </label>
                    ) : selectedEvent.pointOfContact?.noPointOfContact && (
                      <div>
                        <p className="font-semibold text-gray-900">No point of contact</p>
                      </div>
                    )}
                    {(selectedEvent.pointOfContact?.name || isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Name</p>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editData.pointOfContact?.name || ''}
                            onChange={(e) => handleNestedChange('pointOfContact', 'name', e.target.value)}
                            className="w-full px-3 py-2 border border-indigo-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{selectedEvent.pointOfContact.name}</p>
                        )}
                      </div>
                    )}
                    {(selectedEvent.pointOfContact?.phone || isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Phone</p>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editData.pointOfContact?.phone || ''}
                            onChange={(e) => handleNestedChange('pointOfContact', 'phone', e.target.value)}
                            className="w-full px-3 py-2 border border-indigo-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{selectedEvent.pointOfContact.phone}</p>
                        )}
                      </div>
                    )}
                    {(selectedEvent.pointOfContact?.email || isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Email</p>
                        {isEditing ? (
                          <input
                            type="email"
                            value={editData.pointOfContact?.email || ''}
                            onChange={(e) => handleNestedChange('pointOfContact', 'email', e.target.value)}
                            className="w-full px-3 py-2 border border-indigo-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{selectedEvent.pointOfContact.email}</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedEvent.companyName === 'Yellow Block' && (selectedEvent.flowerCollection?.shopLocation || selectedEvent.flowerCollection?.pictureUrl || selectedEvent.flowerCollection?.flowerCount || isEditing) && (
                <div className="bg-pink-50 p-4 rounded-lg border border-pink-200">
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-5 h-5 text-pink-600" />
                    <span className="font-semibold text-gray-900">Flower Collection</span>
                  </div>
                  <div className="space-y-3">
                    {(selectedEvent.flowerCollection?.shopLocation || isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Flower Shop Location</p>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editData.flowerCollection?.shopLocation || ''}
                            onChange={(e) => handleNestedChange('flowerCollection', 'shopLocation', e.target.value)}
                            className="w-full px-3 py-2 border border-pink-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{selectedEvent.flowerCollection.shopLocation}</p>
                        )}
                      </div>
                    )}
                    {(!!selectedEvent.flowerCollection?.flowerCount || isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Number of Flowers</p>
                        {isEditing ? (
                          <input
                            type="number"
                            min="1"
                            value={editData.flowerCollection?.flowerCount || 1}
                            onChange={(e) => handleNestedChange('flowerCollection', 'flowerCount', parseInt(e.target.value, 10) || 1)}
                            className="w-full px-3 py-2 border border-pink-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{selectedEvent.flowerCollection.flowerCount}</p>
                        )}
                      </div>
                    )}
                    {(selectedEvent.flowerCollection?.pictureUrl || isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600 mb-2">Picture</p>
                        {isEditing ? (
                          <input
                            type="url"
                            value={editData.flowerCollection?.pictureUrl || ''}
                            onChange={(e) => handleNestedChange('flowerCollection', 'pictureUrl', e.target.value)}
                            className="w-full px-3 py-2 border border-pink-200 rounded-lg"
                            placeholder="Picture URL"
                          />
                        ) : (
                          <img
                            src={selectedEvent.flowerCollection.pictureUrl}
                            alt="Flower collection"
                            className="w-40 h-40 object-cover rounded-lg border border-pink-200"
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Logistics */}
              <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
                <div className="flex items-center gap-2 mb-3">
                  <Users className="w-5 h-5 text-purple-600" />
                  <span className="font-semibold text-gray-900">Logistics & Equipment</span>
                </div>

                <div className="space-y-3">
                  <div>
                    <p className="text-sm text-gray-600">Number of People</p>
                    {isEditing ? (
                      <input
                        type="number"
                        min="0"
                        value={editData.logistics?.numberOfPeople || 0}
                        onChange={(e) => handleNestedChange('logistics', 'numberOfPeople', parseInt(e.target.value, 10) || 0)}
                        className="w-full px-3 py-2 border border-purple-200 rounded-lg"
                      />
                    ) : (
                      <p className="font-semibold text-gray-900">{selectedEvent.logistics.numberOfPeople}</p>
                    )}
                  </div>

                  {((selectedEvent.logistics.staffNames?.length > 0) || isEditing) && (
                    <div>
                      <p className="text-sm text-gray-600 mb-1">Staff Members</p>
                      {isEditing ? (
                        <textarea
                          value={(editData.logistics?.staffNames || []).join(', ')}
                          onChange={(e) => handleNestedChange('logistics', 'staffNames', e.target.value.split(',').map((name) => name.trim()).filter(Boolean))}
                          className="w-full px-3 py-2 border border-purple-200 rounded-lg"
                          rows={2}
                          placeholder="Enter names separated by commas"
                        />
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {(selectedEvent.logistics.staffNames || []).map(
                            (name, i) =>
                              name && (
                                <span key={i} className="px-3 py-1 bg-white border border-purple-200 rounded-full text-sm text-gray-900">
                                  {name}
                                </span>
                              )
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(selectedEvent.logistics.specialRequests || isEditing) && (
                    <div>
                      <p className="text-sm text-gray-600">Special Requests</p>
                      {isEditing ? (
                        <textarea
                          value={editData.logistics?.specialRequests || ''}
                          onChange={(e) => handleNestedChange('logistics', 'specialRequests', e.target.value)}
                          className="w-full px-3 py-2 border border-purple-200 rounded-lg"
                          rows={3}
                        />
                      ) : (
                        <p className="font-semibold text-gray-900 bg-white p-3 rounded border border-purple-200">
                          {selectedEvent.logistics.specialRequests}
                        </p>
                      )}
                    </div>
                  )}

                  {selectedEvent.logistics.equipment?.length > 0 && (
                    <div>
                      <p className="text-sm text-gray-600 mb-2">Equipment</p>
                      <div className="space-y-2">
                        {selectedEvent.logistics.equipment.map((item, i) => (
                          <div key={i} className="bg-white p-3 rounded border border-purple-200">
                            <p className="font-semibold text-gray-900">{item.name}</p>
                            {item.dimensions && <p className="text-sm text-gray-600">Dimensions: {item.dimensions}</p>}
                            {item.quantity > 1 && <p className="text-sm text-gray-600">Quantity: {item.quantity}</p>}
                            {item.description && <p className="text-sm text-gray-600">{item.description}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedEvent.logistics.assetsUsed?.length > 0 && (
                    <div>
                      <p className="text-sm text-gray-600 mb-2">Asset Usage</p>
                      <div className="space-y-2">
                        {selectedEvent.logistics.assetsUsed.map((asset, i) => (
                          <div key={`${asset.assetId || 'asset'}-${i}`} className="bg-white p-3 rounded border border-purple-200 flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg overflow-hidden bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
                              {asset.imageUrl ? (
                                <img src={asset.imageUrl} alt={asset.itemType} className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-5 h-5 rounded bg-purple-100" />
                              )}
                            </div>
                            <div>
                              <p className="font-semibold text-gray-900">{asset.itemType}</p>
                              <p className="text-sm text-gray-600">Used: {asset.quantityUsed} {asset.unit}</p>
                              {asset.placeOfStorage && <p className="text-sm text-gray-600">Storage: {asset.placeOfStorage}</p>}
                              {asset.totalPrice !== undefined && (
                                <p className="text-sm text-gray-600">Cost: AED {Number(asset.totalPrice || 0).toFixed(2)}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                      <p className="text-sm text-gray-600 mb-2">Food Items</p>
                      <div className="space-y-2">
                        {(isEditing ? (editData.logistics?.food || []) : (selectedEvent.logistics.food || [])).length === 0 && !isEditing && (
                          <p className="text-sm text-gray-400 italic bg-white p-3 rounded border border-dashed border-purple-200">
                            No food items recorded — click Edit to add food requirements.
                          </p>
                        )}
                        {(isEditing ? (editData.logistics?.food || []) : (selectedEvent.logistics.food || [])).map((item, i) => (
                          <div key={i} className="bg-white p-3 rounded border border-purple-200 flex items-center justify-between">
                            <div>
                              <p className="font-semibold text-gray-900">{item.name}</p>
                              {item.description && <p className="text-sm text-gray-600">{item.description}</p>}
                              {item.quantity > 1 && <p className="text-sm text-gray-600">Qty: {item.quantity}</p>}
                            </div>
                            {isEditing && (
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = (editData.logistics?.food || []).filter((_, idx) => idx !== i);
                                  handleNestedChange('logistics', 'food', updated);
                                }}
                                className="ml-3 text-red-500 hover:text-red-700 text-xs font-semibold"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {isEditing && (
                        <div className="mt-2 flex gap-2">
                          <input
                            type="text"
                            placeholder="Food item name"
                            value={newFoodItem.name}
                            onChange={(e) => setNewFoodItem((p) => ({ ...p, name: e.target.value }))}
                            className="flex-1 px-3 py-2 border border-purple-200 rounded-lg text-sm"
                          />
                          <input
                            type="number"
                            min="1"
                            placeholder="Qty"
                            value={newFoodItem.quantity}
                            onChange={(e) => setNewFoodItem((p) => ({ ...p, quantity: parseInt(e.target.value) || 1 }))}
                            className="w-16 px-3 py-2 border border-purple-200 rounded-lg text-sm"
                          />
                          <button
                            type="button"
                            disabled={!newFoodItem.name.trim()}
                            onClick={() => {
                              if (!newFoodItem.name.trim()) return;
                              const updated = [...(editData.logistics?.food || []), { name: newFoodItem.name.trim(), quantity: newFoodItem.quantity }];
                              handleNestedChange('logistics', 'food', updated);
                              setNewFoodItem({ name: '', quantity: 1 });
                            }}
                            className="px-3 py-2 bg-purple-600 text-white rounded-lg text-sm font-semibold hover:bg-purple-700 disabled:bg-gray-400"
                          >
                            Add
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

              {/* Disassembly */}
              {(selectedEvent.disassembly.isRequired || isEditing) && (
                <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                  <h4 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-orange-600" />
                    Disassembly Required
                  </h4>
                  <div className="space-y-2">
                    {isEditing && (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={!!editData.disassembly?.isRequired}
                          onChange={(e) => handleNestedChange('disassembly', 'isRequired', e.target.checked)}
                        />
                        <span className="text-sm text-gray-700">Disassembly required</span>
                      </label>
                    )}
                    {(selectedEvent.disassembly.date || isEditing) && (editData.disassembly?.isRequired || !isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Date</p>
                        {isEditing ? (
                          <input
                            type="date"
                            value={editData.disassembly?.date || ''}
                            onChange={(e) => handleNestedChange('disassembly', 'date', e.target.value)}
                            className="w-full px-3 py-2 border border-orange-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{formatDate(selectedEvent.disassembly.date)}</p>
                        )}
                      </div>
                    )}
                    {(selectedEvent.disassembly.arrivalTime || isEditing) && (editData.disassembly?.isRequired || !isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Driver Arrival Time</p>
                        {isEditing ? (
                          <input
                            type="time"
                            value={editData.disassembly?.arrivalTime || ''}
                            onChange={(e) => handleNestedChange('disassembly', 'arrivalTime', e.target.value)}
                            className="w-full px-3 py-2 border border-orange-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{selectedEvent.disassembly.arrivalTime}</p>
                        )}
                      </div>
                    )}
                    {(selectedEvent.disassembly.disassemblyTime || isEditing) && (editData.disassembly?.isRequired || !isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Disassembly Time</p>
                        {isEditing ? (
                          <input
                            type="time"
                            value={editData.disassembly?.disassemblyTime || ''}
                            onChange={(e) => handleNestedChange('disassembly', 'disassemblyTime', e.target.value)}
                            className="w-full px-3 py-2 border border-orange-200 rounded-lg"
                          />
                        ) : (
                          <p className="font-semibold text-gray-900">{selectedEvent.disassembly.disassemblyTime}</p>
                        )}
                      </div>
                    )}
                    {(selectedEvent.disassembly.notes || isEditing) && (editData.disassembly?.isRequired || !isEditing) && (
                      <div>
                        <p className="text-sm text-gray-600">Notes</p>
                        {isEditing ? (
                          <textarea
                            value={editData.disassembly?.notes || ''}
                            onChange={(e) => handleNestedChange('disassembly', 'notes', e.target.value)}
                            className="w-full px-3 py-2 border border-orange-200 rounded-lg"
                            rows={2}
                          />
                        ) : (
                          <p className="font-semibold text-gray-900 bg-white p-2 rounded border border-orange-200">
                            {selectedEvent.disassembly.notes}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Assigned Driver */}
              {selectedEvent.assignedDriver && (
                <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
                  <h4 className="font-semibold text-gray-900 mb-2">Assigned Driver</h4>
                  <p className="text-lg font-bold text-emerald-700">{selectedEvent.driverName}</p>
                </div>
              )}

              {/* Notes */}
              {(selectedEvent.notes || isEditing) && (
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <h4 className="font-semibold text-gray-900 mb-2">Notes</h4>
                  {isEditing ? (
                    <textarea
                      value={editData.notes || ''}
                      onChange={(e) => handleFieldChange('notes', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg"
                      rows={3}
                    />
                  ) : (
                    <p className="text-gray-700 whitespace-pre-wrap">{selectedEvent.notes}</p>
                  )}
                </div>
              )}

              {/* Close */}
              <div className="flex gap-4 pt-4 border-t">
                <button
                  onClick={onClose}
                  className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition"
                >
                  Close
                </button>
              </div>
            </div>
          </motion.div>

          {/* Cancel Confirmation Dialog */}
          <AnimatePresence>
            {showCancelConfirm && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black bg-opacity-50 z-10 flex items-center justify-center rounded-lg p-6"
              >
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.9, opacity: 0 }}
                  className="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full"
                >
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                      <AlertTriangle className="w-6 h-6 text-red-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-gray-900">Cancel Event?</h3>
                      <p className="text-sm text-gray-500">This action can be reversed later.</p>
                    </div>
                  </div>
                  <p className="text-sm text-gray-700 mb-6">
                    Are you sure you want to cancel <span className="font-semibold">{selectedEvent.eventName}</span>? The event will be marked as cancelled and appear gray on the calendar.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setShowCancelConfirm(false)}
                      className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-semibold text-sm"
                    >
                      Keep Event
                    </button>
                    <button
                      onClick={handleCancelEvent}
                      disabled={isLoading}
                      className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-semibold text-sm disabled:opacity-50"
                    >
                      {isLoading ? 'Cancelling...' : 'Yes, Cancel It'}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default EventDetailModal;
