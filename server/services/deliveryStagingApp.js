import express from 'express';
import cors from 'cors';
import compression from 'compression';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { stagingRequestAllowed } from './deliveryStagingConfig.js';

export const deliveryStagingRoutes = [
  ['/api/mobile', 'mobileUpdates'],
  ['/api/auth', 'auth'], ['/api/users/drivers', 'drivers'], ['/api/users', 'users'],
  ['/api/deliveries', 'deliveries'], ['/api/drivers', 'drivers'], ['/api/customers', 'customers'],
  ['/api/bags', 'bags'], ['/api/bag-operations', 'bagOperations'], ['/api/bag-notes', 'bagNotes'],
  ['/api/store-keeper-scans', 'storeKeeperScans'], ['/api/delivery-issues', 'deliveryIssues'],
  ['/api/handoffs', 'handoffs'],
];

export function createDeliveryStagingApp({ origin, uploadsDir, routers, protect, databaseReady }) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(cors({ origin, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use((_req, res, next) => { res.set('X-MATTER-Environment', 'staging-delivery'); next(); });
  app.get('/api/health', (_req, res) => {
    const connected = databaseReady();
    res.status(connected ? 200 : 503).json({ success: connected, environment: 'staging-delivery',
      database: connected ? 'connected' : 'disconnected', websiteEnabled: false, backgroundJobsEnabled: false,
      driverCaptureEnabled: Boolean(routers.driverEvents) && process.env.ENABLE_DRIVER_CAPTURE_INGESTION === '1' });
  });
  app.use((req, res, next) => stagingRequestAllowed(req.path) ? next()
    : res.status(404).json({ success: false, message: 'This integration is not available in delivery staging.' }));
  mkdirSync(uploadsDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, done) => done(null, `staging-${randomUUID()}.${file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg'}`),
  });
  const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, done) => done(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) });
  app.post('/api/upload/delivery-photo', protect, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'Upload one JPEG, PNG or WebP image.' });
    res.json({ success: true, url: `${origin}/uploads/${encodeURIComponent(req.file.filename)}`,
      filename: req.file.filename, size: req.file.size });
  });
  app.use('/uploads', express.static(uploadsDir, { dotfiles: 'deny', index: false }));
  for (const [prefix, name] of deliveryStagingRoutes) app.use(prefix, routers[name]);
  if (routers.driverEvents) app.use('/api/driver-events', routers.driverEvents);
  app.use((_req, res) => res.status(404).json({ success: false, message: 'Delivery staging API only. No website is installed.' }));
  app.use((error, _req, res, _next) => res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || 500)
    .json({ success: false, message: error.code === 'LIMIT_FILE_SIZE' ? 'Photo exceeds 10 MB.' : 'Staging request failed.' }));
  return app;
}
