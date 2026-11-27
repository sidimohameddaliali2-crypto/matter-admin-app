import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import Vehicle from '../models/Vehicle.js';
import router from './drivers.js';

test('driver list batches current fleet assignments and returns only display fields without changing records', async t => {
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic-driver-vehicle-test';
  t.after(() => { if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; });
  const driverA = 'a'.repeat(24), driverB = 'b'.repeat(24);
  let drivers = [{ _id: driverA, profile: { firstName: 'Synthetic Alpha' } }, { _id: driverB, profile: { firstName: 'Synthetic Beta', vehicleId: 'VAN-2' } }];
  t.mock.method(User, 'findById', () => ({ select: async () => ({ _id: 'staff', role: 'dispatcher', isActive: true }) }));
  t.mock.method(User, 'find', () => ({ select: () => ({ populate: () => ({ lean: async () => drivers }) }) }));
  t.mock.method(Delivery, 'aggregate', async () => []);
  let reads = 0;
  t.mock.method(Vehicle, 'find', filter => {
    reads++;
    assert.deepEqual(filter, { assignedDriver: { $in: [driverA, driverB] } });
    return { select: fields => {
      assert.equal(fields, '_id vehicleId plateNumber type assignedDriver');
      return { lean: async () => [
        { _id: 'v1', assignedDriver: driverA, vehicleId: 'BIKE-1', plateNumber: 'DXB-71592', type: 'bike', notes: 'private-note', fuelLevel: 80 },
        { _id: 'v2', assignedDriver: driverA, vehicleId: 'CAR-1', plateNumber: 'DXB-999', type: 'car' },
      ] };
    } };
  });
  const app = express(); app.use('/drivers', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/drivers`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(reads, 0);
  const headers = { Authorization: `Bearer ${jwt.sign({ id: 'staff' }, process.env.JWT_SECRET)}` };
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data[0].assignedVehicles, [
    { _id: 'v1', vehicleId: 'BIKE-1', plateNumber: 'DXB-71592', type: 'bike' },
    { _id: 'v2', vehicleId: 'CAR-1', plateNumber: 'DXB-999', type: 'car' },
  ]);
  assert.deepEqual(data[1].assignedVehicles, []);
  assert.equal(data[1].profile.vehicleId, 'VAN-2');
  assert.equal(data[0].todayDeliveries, 0);
  drivers = [];
  assert.deepEqual(await (await fetch(url, { headers })).json(), []);
  assert.equal(reads, 1);
});
