import './loadEnv.js';
import mongoose from 'mongoose';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Server } from 'socket.io';
import { deliveryStagingConfig } from './services/deliveryStagingConfig.js';
import { createDeliveryStagingApp, deliveryStagingRoutes } from './services/deliveryStagingApp.js';

const config = deliveryStagingConfig();
process.env.ENABLE_SLACK_NOTIFICATIONS = '0';
process.env.REVERSE_GEOCODE_DISABLED = '1';
process.env.DISABLE_DRIVER_PUSH = '1';
process.env.MOBILE_ANDROID_MIN_BUILD = '0';
const serverDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(serverDir);
const routers = {};
for (const name of new Set(deliveryStagingRoutes.map(([, name]) => name))) {
  routers[name] = (await import(`./routes/${name}.js`)).default;
}
if (existsSync(path.join(serverDir, 'routes/driverEvents.js'))) {
  routers.driverEvents = (await import('./routes/driverEvents.js')).default;
}
const { protect } = await import('./middleware/auth.js');
const { authenticateSocket, registerStaffSocket } = await import('./middleware/socketAuth.js');
const app = createDeliveryStagingApp({ ...config, routers, protect,
  uploadsDir: path.join(serverDir, 'uploads'), databaseReady: () => mongoose.connection.readyState === 1 });
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.origin, credentials: true } });
io.use(authenticateSocket);
io.on('connection', registerStaffSocket);
app.set('io', io);

try {
  await mongoose.connect(config.uri, { maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 10000 });
  server.listen(config.port, '127.0.0.1', () => console.log(`Delivery staging API listening on 127.0.0.1:${config.port}; jobs and website disabled.`));
} catch {
  console.error('Staging database connection failed. Check the staging URI, user permissions and Atlas IP access list.');
  await mongoose.disconnect();
  process.exitCode = 1;
}

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  io.close(async () => { await mongoose.disconnect(); clearTimeout(deadline); });
});
