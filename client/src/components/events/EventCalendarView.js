import React, { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Clock, MapPin, Users, Briefcase } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const EventCalendarView = ({ events, onEventClick, onDayClick, hideDetailPanel = false }) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(null);

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

  // Yellow Block event delivered by a Matter driver: half Yellow Block pink,
  // half Matter blue, and labelled as such.
  const isMatterDriven = (event) => event.companyName === 'Yellow Block' && event.driverProvider === 'matter';
  const SPLIT_BACKGROUND = 'linear-gradient(to right, #f0a3ed 0%, #f0a3ed 50%, #2563eb 50%, #2563eb 100%)';

  // Get calendar days for current month
  const getDaysInMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const daysInMonth = getDaysInMonth(currentDate);
  const firstDay = getFirstDayOfMonth(currentDate);
  const calendarDays = [];

  // Add empty cells for days before month starts
  for (let i = 0; i < firstDay; i++) {
    calendarDays.push(null);
  }

  // Add days of month
  for (let i = 1; i <= daysInMonth; i++) {
    calendarDays.push(new Date(currentDate.getFullYear(), currentDate.getMonth(), i));
  }

  // Group events by date
  const eventsByDate = useMemo(() => {
    const grouped = {};
    events.forEach((event) => {
      const dateKey = new Date(event.eventDate).toLocaleDateString('en-US');
      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }
      grouped[dateKey].push(event);
    });
    return grouped;
  }, [events]);

  const getEventsForDate = (date) => {
    if (!date) return [];
    const dateKey = date.toLocaleDateString('en-US');
    return eventsByDate[dateKey] || [];
  };

  const formatTime = (timeStr) => {
    if (!timeStr) return '';
    const [hours, minutes] = timeStr.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  };

  const handlePrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));
  };

  const handleDayClick = (day) => {
    const dayEvents = getEventsForDate(day);
    if (dayEvents.length > 0) {
      setSelectedDay(day);
      onDayClick?.(day, dayEvents);
    }
  };

  const monthName = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="space-y-6">
      {/* Calendar Grid */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {/* Month Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-bold text-gray-900">{monthName}</h2>
          <div className="flex gap-2">
            <button
              onClick={handlePrevMonth}
              className="p-2 hover:bg-gray-100 rounded-lg transition"
              title="Previous month"
            >
              <ChevronLeft className="w-5 h-5 text-gray-600" />
            </button>
            <button
              onClick={() => setCurrentDate(new Date())}
              style={{ color: getCompanyColor(events[0]?.companyName).text, backgroundColor: getCompanyColor(events[0]?.companyName).lighter }}
              className="px-4 py-2 text-sm font-semibold hover:opacity-80 rounded-lg transition"
            >
              Today
            </button>
            <button
              onClick={handleNextMonth}
              className="p-2 hover:bg-gray-100 rounded-lg transition"
              title="Next month"
            >
              <ChevronRight className="w-5 h-5 text-gray-600" />
            </button>
          </div>
        </div>

        {/* Day Names */}
        <div className="grid grid-cols-7 gap-0 bg-gray-50 border-b border-gray-200">
          {dayNames.map((day) => (
            <div key={day} className="p-3 text-center font-semibold text-gray-700 text-sm border-r border-gray-200 last:border-r-0">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar Days */}
        <div className="grid grid-cols-7 gap-0 bg-white">
          <AnimatePresence>
            {calendarDays.map((day, index) => {
              const dayEvents = getEventsForDate(day);
              const isToday = day && new Date().toDateString() === day.toDateString();
              const isSelected = selectedDay && day && selectedDay.toDateString() === day.toDateString();
              const isCurrentMonth = day && day.getMonth() === currentDate.getMonth();

              return (
                <motion.div
                  key={index}
                  className={`aspect-square border-r border-b border-gray-200 last-col:border-r-0 p-2 min-h-[120px] flex flex-col cursor-pointer transition ${
                    day === null ? 'bg-gray-50' : 'bg-white hover:bg-blue-50'
                  } ${isCurrentMonth ? '' : 'bg-gray-50'} ${isToday ? 'bg-blue-50 border-2 border-blue-300' : ''} ${
                    isSelected ? 'bg-blue-100 border-2 border-blue-500' : ''
                  }`}
                  onClick={() => day && handleDayClick(day)}
                >
                  {day && (
                    <>
                      {/* Day Number */}
                      <div className={`text-sm font-bold mb-1 ${isCurrentMonth ? 'text-gray-900' : 'text-gray-400'}`}>
                        {day.getDate()}
                      </div>

                      {/* Events for this day */}
                      <div className="flex-1 overflow-y-auto space-y-1">
                        {dayEvents.slice(0, 2).map((event) => {
                          const isCancelled = event.status === 'cancelled';
                          const companyColor = getCompanyColor(event.companyName);
                          return (
                          <motion.div
                            key={event._id}
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onEventClick?.(event);
                            }}
                            style={isCancelled ? {} : {
                              background: isMatterDriven(event)
                                ? SPLIT_BACKGROUND
                                : (event.companyName?.toLowerCase().includes('matter') && event.isPaid)
                                  ? 'linear-gradient(to right, #16a34a 0%, #15803d 100%)'
                                  : `linear-gradient(to right, ${companyColor.bgFrom} 0%, ${companyColor.bgTo} 100%)`,
                              color: 'white',
                              ...(isMatterDriven(event) ? { textShadow: '0 1px 2px rgba(0,0,0,0.6)' } : {})
                            }}
                            className={`text-xs p-1 rounded cursor-pointer hover:shadow-md transition truncate font-semibold ${
                              isCancelled
                                ? 'bg-gray-200 text-gray-500 line-through'
                                : ''
                            }`}
                            title={`${event.eventName}${isMatterDriven(event) ? ' (delivered by Matter driver)' : ''}${isCancelled ? ' (Cancelled)' : ''}`}
                          >
                            {event.eventName}
                          </motion.div>
                        );
                        })}

                        {/* More events indicator */}
                        {dayEvents.length > 2 && (() => {
                          const companyColor = getCompanyColor(dayEvents[0]?.companyName);
                          return (
                            <div style={{ color: companyColor.textLight }} className="text-xs font-semibold px-1">
                              +{dayEvents.length - 2} more
                            </div>
                          );
                        })()}
                      </div>

                      {/* Event count badge */}
                      {dayEvents.length > 0 && (() => {
                        const companyColor = getCompanyColor(dayEvents[0]?.companyName);
                        return (
                          <div className="text-xs mt-1 pt-1 border-t border-gray-200">
                            <span style={{
                              backgroundColor: companyColor.light,
                              color: companyColor.text,
                              borderColor: companyColor.border
                            }} className="inline-block px-2 py-0.5 rounded font-semibold border">
                              {dayEvents.length} event{dayEvents.length > 1 ? 's' : ''}
                            </span>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Day Detail View */}
      {!hideDetailPanel && selectedDay && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="bg-white rounded-lg border border-gray-200 shadow-lg overflow-hidden"
        >
          {/* Day Header */}
          <div style={{
            background: selectedDay ? `linear-gradient(to right, ${getCompanyColor(getEventsForDate(selectedDay)[0]?.companyName).bgFrom} 0%, ${getCompanyColor(getEventsForDate(selectedDay)[0]?.companyName).bgTo} 100%)` : 'linear-gradient(to right, #2563eb 0%, #1d4ed8 100%)'
          }} className="p-6 text-white flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold opacity-80">
                {selectedDay.toLocaleDateString('en-US', { weekday: 'long' })}
              </h3>
              <h2 className="text-3xl font-bold">
                {selectedDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </h2>
            </div>
            <button
              onClick={() => setSelectedDay(null)}
              className="p-2 hover:opacity-80 rounded-lg transition"
            >
              ✕
            </button>
          </div>

          {/* Events for selected day */}
          <div className="p-6 space-y-4">
            {getEventsForDate(selectedDay).map((event, index) => (
              <motion.div
                key={event._id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className="border border-gray-200 rounded-lg overflow-hidden hover:shadow-lg transition cursor-pointer"
                onClick={() => onEventClick?.(event)}
              >
                <div style={event.status === 'cancelled' ? {} : {
                  background: isMatterDriven(event)
                    ? SPLIT_BACKGROUND
                    : `linear-gradient(to right, ${getCompanyColor(event.companyName).bgFrom} 0%, ${getCompanyColor(event.companyName).bgTo} 100%)`
                }} className={`p-4 flex items-center justify-between ${
                  event.status === 'cancelled' ? 'bg-gray-200' : ''
                }`}>
                  <div className="flex items-center gap-3 flex-1">
                    {event.companyLogo ? (
                      <img
                        src={event.companyLogo}
                        alt={event.companyName}
                        className="w-10 h-10 rounded object-cover border-2 border-white"
                      />
                    ) : (
                      <div style={{
                        backgroundColor: 'white',
                        color: getCompanyColor(event.companyName).text
                      }} className="w-10 h-10 rounded flex items-center justify-center font-bold border-2 border-white">
                        {event.companyName.charAt(0)}
                      </div>
                    )}
                    <div>
                      <h4 className={`font-bold ${event.status === 'cancelled' ? 'text-gray-500 line-through' : 'text-white'}`}>{event.companyName}</h4>
                      <p className={`text-sm ${event.status === 'cancelled' ? 'text-gray-400' : 'opacity-90 text-white'}`}>{event.eventName}</p>
                      {event.status === 'cancelled' && (
                        <span className="text-xs font-semibold text-red-500 bg-red-100 px-2 py-0.5 rounded">Cancelled</span>
                      )}
                      {isMatterDriven(event) && (
                        <span className="text-xs font-bold text-blue-800 bg-white px-2 py-0.5 rounded inline-block mt-1">🚚 Delivered by Matter driver</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Event Details */}
                <div className="p-4 space-y-3">
                  {/* Time Section */}
                  <div className="space-y-2 pb-3 border-b border-gray-200">
                    <h4 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
                      <Clock className="w-4 h-4" style={{ color: getCompanyColor(event.companyName).text }} />
                      Schedule
                    </h4>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-gray-600">Arrival Time</p>
                        <p className="font-bold text-lg text-gray-900">{formatTime(event.arrivalTime)}</p>
                      </div>
                      {event.disassembly.isRequired && (
                        <div>
                          <p className="text-gray-600">Disassembly</p>
                          <p className="font-bold text-lg text-orange-600">{formatTime(event.disassembly.disassemblyTime)}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Location */}
                  <div className="flex items-start gap-3">
                    <MapPin className="w-4 h-4 text-red-600 mt-1 flex-shrink-0" />
                    <div className="text-sm">
                      <p className="text-gray-600">{event.venue.type} in {event.emirate}</p>
                      <p className="font-semibold text-gray-900">{event.venue.area || event.venue.address}</p>
                      {event.venue.googleMapsLink && (
                        <a
                          href={event.venue.googleMapsLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 text-xs font-semibold hover:underline mt-1 inline-block"
                        >
                          View on Maps →
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Logistics */}
                  {event.logistics.numberOfPeople > 0 && (() => {
                    const companyColor = getCompanyColor(event.companyName);
                    return (
                      <div style={{
                        backgroundColor: companyColor.lighter,
                        borderColor: companyColor.border
                      }} className="flex items-start gap-3 p-3 rounded border">
                        <Users style={{ color: companyColor.text }} className="w-4 h-4 mt-1 flex-shrink-0" />
                        <div className="text-sm">
                          <p style={{ color: companyColor.text }} className="font-semibold">{event.logistics.numberOfPeople} Staff Members</p>
                          {event.logistics.staffNames?.length > 0 && (
                            <p style={{ color: companyColor.textLight }} className="text-xs mt-1">{event.logistics.staffNames.join(', ')}</p>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Equipment */}
                  {event.logistics.equipment?.length > 0 && (
                    <div className="p-3 bg-amber-50 rounded border border-amber-200">
                      <h5 className="font-semibold text-amber-900 mb-2 flex items-center gap-2">
                        <Briefcase className="w-4 h-4" />
                        Equipment ({event.logistics.equipment.length})
                      </h5>
                      <div className="space-y-2">
                        {event.logistics.equipment.map((item, idx) => (
                          <div key={idx} className="text-sm bg-white p-2 rounded border border-amber-200">
                            <p className="font-semibold text-amber-900">{item.name}</p>
                            {item.dimensions && <p className="text-amber-700">Dimensions: {item.dimensions}</p>}
                            {item.quantity && <p className="text-amber-700">Quantity: {item.quantity}</p>}
                            {item.description && <p className="text-amber-600 text-xs mt-1">{item.description}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Food Items */}
                  {event.logistics.food && event.logistics.food.length > 0 && (
                    <div className="p-3 bg-green-50 rounded border border-green-200">
                      <h5 className="font-semibold text-green-900 mb-2 flex items-center gap-2">
                        🍽️ Food Items ({event.logistics.food.length})
                      </h5>
                      <div className="space-y-2">
                        {event.logistics.food.map((item, idx) => (
                          <div key={idx} className="text-sm bg-white p-2 rounded border border-green-200">
                            <p className="font-semibold text-green-900">{item.name}</p>
                            {item.quantity > 1 && <p className="text-green-700">Quantity: {item.quantity}</p>}
                            {item.description && <p className="text-green-600 text-xs mt-1">{item.description}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Special Requests */}
                  {event.logistics.specialRequests && (
                    <div className="p-3 bg-purple-50 rounded border border-purple-200">
                      <p className="font-semibold text-purple-900 mb-1">⭐ Special Requests</p>
                      <p className="text-purple-700 text-sm">{event.logistics.specialRequests}</p>
                    </div>
                  )}

                  {/* Disassembly Details */}
                  {event.disassembly.isRequired && (
                    <div className="p-3 bg-orange-50 rounded border border-orange-200">
                      <p className="font-semibold text-orange-900 mb-2">🔧 Disassembly Required</p>
                      <div className="space-y-1 text-sm text-orange-700">
                        <p>
                          <span className="font-semibold">Date:</span>{' '}
                          {new Date(event.disassembly.date).toLocaleDateString()}
                        </p>
                        <p>
                          <span className="font-semibold">Arrival:</span> {formatTime(event.disassembly.arrivalTime)}
                        </p>
                        <p>
                          <span className="font-semibold">Time:</span> {formatTime(event.disassembly.disassemblyTime)}
                        </p>
                        {event.disassembly.notes && <p className="mt-1">{event.disassembly.notes}</p>}
                      </div>
                    </div>
                  )}

                  {/* Notes */}
                  {event.notes && (
                    <div className="p-3 bg-gray-50 rounded border border-gray-200">
                      <p className="font-semibold text-gray-900 mb-1">📝 Notes</p>
                      <p className="text-gray-700 text-sm">{event.notes}</p>
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
};

export default EventCalendarView;
