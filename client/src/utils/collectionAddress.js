export function parseCollectionAddress(value) {
  // Accept copied plain text and the backslash line endings in shared addresses.
  const lines = String(value || '').replace(/\\(?=\r?\n)/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Paste an address first.');
  const latLine = lines.find(line => /^latitude\s*:/i.test(line));
  const lngLine = lines.find(line => /^longitude\s*:/i.test(line));
  const mapLine = lines.find(line => /https?:/i.test(line));
  let latitude = latLine?.split(':').slice(1).join(':').trim() || '';
  let longitude = lngLine?.split(':').slice(1).join(':').trim() || '';
  const pair = mapLine?.replace(/\\/g, '').match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i);
  if (!latitude && !longitude && pair) [, latitude, longitude] = pair;
  if ((latitude || longitude) && (!latitude || !longitude || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude)) || Math.abs(Number(latitude)) > 90 || Math.abs(Number(longitude)) > 180)) {
    throw new Error('The copied coordinates are invalid. Check the latitude and longitude.');
  }
  const addressLines = lines.filter(line => !/^(latitude|longitude|map pin)\s*:/i.test(line) && !/https?:/i.test(line));
  let addressLabel = '';
  if (addressLines.length > 1 && /^(home|work|office|other)$/i.test(addressLines[0])) addressLabel = addressLines.shift();
  const address = addressLines.join(', ');
  if (!address) throw new Error('No street address found. Paste the full address, including the street.');
  return { address, addressLabel, latitude, longitude };
}
