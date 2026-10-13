// Must stay the very first import: ES module imports are always resolved
// and evaluated before any of THIS file's own top-level code runs — even
// code positioned textually earlier — so loading dotenv here (as a side
// effect of the first import) is the only way to guarantee every route
// module imported below sees process.env already populated. See
// loadEnv.js for the full explanation.
import './loadEnv.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔧 Environment check:', {
  nodeEnv: process.env.NODE_ENV,
  mongodbUri: process.env.MONGODB_URI?.substring(0, 50) + '...',
  port: process.env.PORT,
  hasSpacesKey: !!process.env.SPACES_KEY,
  hasSpacesSecret: !!process.env.SPACES_SECRET,
  spacesEndpoint: process.env.SPACES_ENDPOINT
});

// Now import everything else
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import compression from 'compression';
import http from 'http';
import { Server } from 'socket.io';
import { initializeSpaces } from './config/spaces.js';
import { startFlaggedNotifier } from './jobs/flaggedCustomerNotifier.js';
import { startMoveUncollectedCollectionsJob } from './jobs/moveUncollectedCollections.js';
import { startRecalculateDriverKpisJob } from './jobs/recalculateDriverKpis.js';
import { startImportMatterDeliveriesJob } from './jobs/importMatterDeliveries.js';
import { startRecordVehicleLocationsJob } from './jobs/recordVehicleLocations.js';

// Initialize Spaces after dotenv loads
initializeSpaces();

// Create Express app
const app = express();
const server = http.createServer(app);

// Origins allowed to call the API with credentials. The SPA is served by this
// same server, so genuine same-origin requests never need an entry (the browser
// doesn't CORS-check them) — this list is for real cross-origin callers and
// Socket.IO. Add more via ALLOWED_ORIGINS (comma-separated) without a code change.
const defaultOrigins = [
  process.env.CLIENT_URL,
  process.env.FRONTEND_URL,
  process.env.API_BASE_URL,
  process.env.SERVER_PUBLIC_URL,
  'https://matterapp.online',
  'http://localhost:3000',
  'http://localhost:5000',
  ...String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim()),
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // No Origin header → same-origin page, curl, or server-to-server: allow.
    if (!origin || defaultOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Unknown cross-origin: withhold CORS headers so the browser blocks it,
    // but do NOT throw — erroring here turns every stray request into a 500
    // and floods the logs. Same-origin requests are unaffected.
    console.warn(`CORS: origin not in allow-list, headers withheld: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
};

const io = new Server(server, {
  cors: {
    ...corsOptions,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }
});

// Make io accessible via Express app (so routes can use req.app.get('io'))
app.set('io', io);

// Middleware
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Serve React static files (Create React App build) with correct MIME types
app.use(express.static(path.join(__dirname, '../client/build'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Database connection
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 20,
      minPoolSize: 5,
      retryWrites: true,
      ssl: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.error('💡 Troubleshooting: Check MongoDB Atlas IP whitelist and connection string');
    // Retry connection after 5 seconds
    console.log('🔄 Retrying connection in 5 seconds...');
    setTimeout(() => connectDB(), 5000);
  }
};

connectDB();

// Mongoose connection event listeners
mongoose.connection.on('connected', () => {
  console.log('✅ Mongoose connected to MongoDB');
  // Setup slow query monitoring after connection
  setupMongooseSlowQueryMonitoring();
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  Mongoose disconnected from MongoDB');
  console.log('🔄 Attempting to reconnect in 5 seconds...');
  setTimeout(() => connectDB(), 5000);
});

mongoose.connection.on('error', (err) => {
  console.error('❌ Mongoose connection error:', err.message);
});

// Import routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import deliveryRoutes from './routes/deliveries.js';
import bagRoutes from './routes/bags.js';
import reportRoutes from './routes/reports.js';
import driverRoutes from './routes/drivers.js';
import uploadRoutes from './routes/upload.js';
import deliveryChangeRoutes from './routes/deliveryChanges.js';
import eventRoutes from './routes/events.js';
import alertsRoutes from './routes/alerts.js';
import communicationRoutes from './routes/communications.js';
import handoffRoutes from './routes/handoffs.js';
import externalRoutePlans from './routes/externalRoutePlans.js';
import menuRoutes from './routes/menus.js';
import supyService from './services/supyService.js';
import customerRoutes from './routes/customers.js';
import incidentRoutes from './routes/incidents.js';
import storeKeeperScansRoutes from './routes/storeKeeperScans.js';
import bagNotesRoutes from './routes/bagNotes.js';
import deliveryIssuesRoutes from './routes/deliveryIssues.js';
import partnerAuthRoutes from './routes/partnerAuth.js';
import partnerPortalRoutes from './routes/partnerPortal.js';
import adminPartnerRoutes from './routes/adminPartners.js';
import memberAuthRoutes from './routes/memberAuth.js';
import memberPortalRoutes from './routes/memberPortal.js';
import webhookRoutes from './routes/webhooks.js';
import employeeRoutes from './routes/employees.js';
import matterCoreRoutes from './routes/matterCore.js';
import matterApiRoutes from './routes/matterApi.js';
import truckoomApiRoutes from './routes/truckoomApi.js';
import xeroRoutes from './routes/xero.js';
import vehicleRoutes from './routes/vehicles.js';
import yellowblockRoutes from './routes/yellowblock.js';
import externalDeliveryApiRoutes from './routes/externalDeliveryApi.js';
import externalDriverLocationApiRoutes from './routes/externalDriverLocationApi.js';

// Import cache initialization
import { initRedis, getRedisClient } from './config/cache.js';
import { createAdapter } from '@socket.io/redis-adapter';
import { setupMongooseSlowQueryMonitoring } from './middleware/slowQueryLogger.js';
// Routes middleware
app.use('/api/auth', authRoutes);
app.use('/api/users/drivers', driverRoutes); // Allow driver routes under /api/users/drivers
app.use('/api/users', userRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/bags', bagRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/delivery-changes', deliveryChangeRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/communications', communicationRoutes);
app.use('/api/handoffs', handoffRoutes);
app.use('/api/route-plans', externalRoutePlans);
app.use('/api/menus', menuRoutes);
app.use('/api/matter-core', matterCoreRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/store-keeper-scans', storeKeeperScansRoutes);
app.use('/api/bag-notes', bagNotesRoutes);
app.use('/api/delivery-issues', deliveryIssuesRoutes);
app.use('/api/partner/auth', partnerAuthRoutes);
app.use('/api/partner', partnerPortalRoutes);
app.use('/api/admin/partners', adminPartnerRoutes);
app.use('/api/member/auth', memberAuthRoutes);
app.use('/api/member', memberPortalRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/matter', matterApiRoutes);
app.use('/api/truckoom', truckoomApiRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/xero', xeroRoutes);
app.use('/api/yellowblock', yellowblockRoutes);
// External/third-party read-only delivery API — authenticated with a static
// API key (DELIVERY_API_KEYS), not the app's own JWT login. See
// middleware/apiKeyAuth.js and docs/EXTERNAL_DELIVERY_API.md.
app.use('/api/external/deliveries', externalDeliveryApiRoutes);
// Same static API key, for live driver/vehicle GPS instead of delivery
// records — see docs/EXTERNAL_DELIVERY_API.md.
app.use('/api/external/drivers', externalDriverLocationApiRoutes);


// Health check endpoint (supports both GET and HEAD methods)
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    success: true, 
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.head('/api/health', (req, res) => {
  res.status(200).end();
});

// Test route to verify server is working
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is running!',
    timestamp: new Date().toISOString()
  });
});

// Test route for drivers endpoint
app.get('/api/users/drivers/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Drivers endpoint is accessible!',
    timestamp: new Date().toISOString()
  });
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Join driver room
  socket.on('driver:join', (driverId) => {
    socket.join(`driver:${driverId}`);
    console.log(`Driver ${driverId} joined room`);
  });

  // Handle delivery status updates
  socket.on('delivery:statusUpdate', (data) => {
    io.emit('delivery:updated', data);
    console.log('Delivery status updated:', data);
  });

  // Handle driver status updates
  socket.on('driver:statusUpdate', (data) => {
    io.emit('driver:statusChanged', data);
    console.log('Driver status updated:', data);
  });

  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
  });
});

// ======== SERVE REACT APP FOR ALL NON-API ROUTES ========
app.get('*', (req, res, next) => {
  // Skip if it's an API route
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
    return next();
  }
  // Serve index.html for all other routes
  // Ensure index shell isn't browser-cached; SW controls other assets
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'), (err) => {
    if (err) {
      console.error('Error serving index.html:', err);
      res.status(500).send('Error loading application');
    }
  });
});
// ===================================================================

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error('🚨 Global error handler:', err.stack);
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler for API routes only
app.use('/api/*', (req, res) => {
  console.log(`❌ 404 - API Route not found: ${req.method} ${req.originalUrl}`);
  
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableRoutes: [
      'GET /api/test',
      'GET /api/users/drivers',
      'POST /api/users/drivers',
      'GET /api/users/drivers/:id',
      'GET /api/deliveries',
      'POST /api/deliveries',
      'GET /api/auth/me',
      'POST /api/auth/login'
    ]
  });
});

const PORT = process.env.PORT || 5000;

// Initialize Redis for caching. Awaited (unlike the old fire-and-forget
// call) so the Socket.io Redis adapter below can attach before the server
// starts accepting connections — initRedis() has its own 5s connectTimeout
// and try/catch, so this resolves within a bounded time either way, it
// just delays startup slightly rather than risking a startup crash.
await initRedis().catch((error) => {
  console.warn('⚠️  Redis initialization failed:', error.message);
  console.log('💡 Continuing without cache. Install Redis for production optimization.');
});

// Socket.io's default adapter only broadcasts within a single process. This
// server deploys via PM2 in cluster mode (see ecosystem.config.cjs), so
// without this, an io.emit() from a request handled by one instance never
// reaches a client connected to the other — e.g. delivery:created/updated
// would silently miss some dispatchers depending on which instance they
// landed on. Reuses the same Redis connection/URL config.js already
// established for caching — not a new Redis instance.
const redisPubClient = getRedisClient();
if (redisPubClient) {
  try {
    const redisSubClient = redisPubClient.duplicate();
    await redisSubClient.connect();
    io.adapter(createAdapter(redisPubClient, redisSubClient));
    console.log('✅ Socket.io Redis adapter attached');
  } catch (error) {
    console.warn('⚠️  Failed to attach Socket.io Redis adapter:', error.message);
    console.warn('   Falling back to the default in-memory adapter — broadcasts will not reach every PM2 instance.');
  }
} else {
  console.warn('⚠️  Socket.io running without a Redis adapter (Redis unavailable) — cross-instance broadcasts will not reach every dispatcher in PM2 cluster mode.');
}

server.listen(PORT, () => {
  console.log(`
🚀 Server running in ${process.env.NODE_ENV || 'development'} mode
📍 Port: ${PORT}
🌐 URL: http://localhost:${PORT}
📚 API: http://localhost:${PORT}/api
🔌 Socket.io: Enabled

📋 Available endpoints:
   ✅ GET  /api/test - Server test
   ✅ GET  /api/users/drivers - Get all drivers
   ✅ POST /api/users/drivers - Create driver
   ✅ GET  /api/users/drivers/:id - Get driver by ID
   ✅ GET  /api/auth/me - Get current user
   ✅ POST /api/auth/login - User login

🔧 Debug endpoints:
   ✅ GET  /api/users/drivers/test - Test drivers endpoint

📱 React app served from: ${path.join(__dirname, '../client/dist')}
  `);

});

// Start background jobs
startFlaggedNotifier();
startMoveUncollectedCollectionsJob();
startRecalculateDriverKpisJob();
startImportMatterDeliveriesJob();
startRecordVehicleLocationsJob();

// Warm the Supy recipe search cache so the first meal-editor search of the
// day isn't the one waiting on a ~2500-recipe cold fetch.
supyService.warmCache();

// Start background notifier if enabled (runs immediately and then at configured interval)
if (process.env.ENABLE_FLAGGED_ALERTS === '1') {
  const intervalHours = parseInt(process.env.FLAGGED_ALERT_INTERVAL_HOURS || '24', 10);
  const intervalMs = intervalHours * 60 * 60 * 1000;
  try {
    startFlaggedNotifier(intervalMs);
    console.log('Flagged alerts notifier started; intervalHours=', intervalHours);
  } catch (err) {
    console.error('Failed to start flagged notifier:', err.message);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log('🚨 Unhandled Promise Rejection:', err.message);
  console.log(err.stack);
  // Close server & exit process
  server.close(() => {
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.log('🚨 Uncaught Exception:', err.message);
  console.log(err.stack);
  process.exit(1);
});

export { io };
