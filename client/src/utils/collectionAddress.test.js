import { parseCollectionAddress } from './collectionAddress';

test('captures the full copied Home address and explicit pin', () => {
  expect(parseCollectionAddress('Home\n29 22nd St, 29 22nd Street, Al Quoz, Dubai, United Arab Emirates\nLatitude: 25.126898\nLongitude: 55.225061\nMap pin: https://www.google.com/maps?q=25.126898,55.225061')).toEqual({ addressLabel: 'Home', address: '29 22nd St, 29 22nd Street, Al Quoz, Dubai, United Arab Emirates', latitude: '25.126898', longitude: '55.225061' });
});
test('accepts Windows lines and copy-format backslashes', () => {
  expect(parseCollectionAddress('Home\\\r\nAl Quoz, Dubai\\\r\nLatitude: 25.126898\\\r\nLongitude: 55.225061').address).toBe('Al Quoz, Dubai');
});
test('extracts coordinates from a map link without latitude labels', () => {
  expect(parseCollectionAddress('Office\nAl Quoz, Dubai\nMap pin: https://www.google.com/maps?query=25.126898%2C55.225061')).toMatchObject({ addressLabel: 'Office', latitude: '25.126898', longitude: '55.225061' });
});
test('plain addresses clear previous coordinates and preserve all address lines', () => {
  expect(parseCollectionAddress('Building 29\nAl Quoz, Dubai')).toEqual({ addressLabel: '', address: 'Building 29, Al Quoz, Dubai', latitude: '', longitude: '' });
});
test.each(['', 'Map pin: https://www.google.com/maps?q=25,55', 'Dubai\nLatitude: 91\nLongitude: 55', 'Dubai\nLatitude: 25', 'Dubai\nLatitude: nope\nLongitude: 55'])('rejects missing address or invalid coordinates: %s', value => {
  expect(() => parseCollectionAddress(value)).toThrow();
});
