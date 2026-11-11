// Child of the explicit localhost-only recovery qualification harness. It cannot
// accept application environment configuration or a remote database address.
import mongoose from 'mongoose';
import History from '../models/VehicleLocationHistory.js';
import { createVehicleLocationCaptureStore } from '../services/vehicleLocationCaptureStore.js';

if (!process.send) throw new Error('Recovery worker requires a parent IPC channel');
process.once('message', async ({ uri, time, lease }) => {
  try {
    if (typeof uri !== 'string' || !/^mongodb:\/\/127\.0\.0\.1:\d+(?:,127\.0\.0\.1:\d+)*\/qualification\?/.test(uri)) {
      throw new Error('Recovery worker only accepts the generated loopback database');
    }
    if (!Number.isFinite(time) || !lease?.batchId) throw new Error('Invalid synthetic worker input');
    await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 15000 });
    const write = History.bulkWrite.bind(History);
    History.bulkWrite = async (operations, options) => {
      await write(operations.slice(0, 1), options);
      process.send({ kind: 'prefix-acknowledged' });
      // Keep this process alive after a real acknowledged prefix. Only the
      // parent kills it; there is deliberately no catch/release/cleanup path.
      await new Promise(() => {});
    };
    const store = createVehicleLocationCaptureStore({ clock: () => new Date(time), leaseMs: 1000, chunkSize: 2 });
    await store.persistBatch(lease);
    throw new Error('Crash qualification unexpectedly finished');
  } catch (error) {
    process.send({ kind: 'worker-failed', message: error.message });
    await mongoose.disconnect();
    process.exitCode = 1;
    process.disconnect();
  }
});
