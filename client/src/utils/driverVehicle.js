const clean = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const typeLabel = type => ({ bike: 'Bike', van: 'Van', car: 'Car', truck: 'Truck' })[clean(type).toLowerCase()] || 'Vehicle';

// Fleet assignments take precedence over manually entered driver profile fields.
// Show every explicit assignment when there are several, rather than guessing.
export function driverVehicleLabel(driver) {
  if (!driver || typeof driver !== 'object') return '';
  const vehicles = Array.isArray(driver.assignedVehicles) ? driver.assignedVehicles : [];
  const labels = vehicles.map(vehicle => {
    const number = clean(vehicle.plateNumber) || clean(vehicle.vehicleId);
    return number ? `${typeLabel(vehicle.type)} ${number}` : '';
  }).filter(Boolean);
  if (labels.length) return [...new Set(labels)].sort().join(' / ');
  const number = clean(driver.profile?.vehicleId) || clean(driver.profile?.truckoomVehicleNo);
  return number ? `${typeLabel(driver.profile?.vehicleType)} ${number}` : '';
}
