// Must be the very first import in server.js. ES module imports are always
// resolved and executed before any of the importing file's own top-level
// code runs — including code positioned textually earlier in that file — so
// a `dotenv.config()` call inside server.js itself runs too late: every
// other module server.js imports (routes/deliveries.js, routes/
// communications.js, etc.) has already been evaluated by then, and any
// module-level `const X = process.env.SOME_VAR` in those files permanently
// captured `undefined`. Loading dotenv here, in a module imported first,
// guarantees process.env is populated before any other import is resolved.
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRuntimeSettings } from './services/apiRuntime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtime = apiRuntimeSettings();
const controlSocket = process.env.MATTER_API_CONTROL_SOCKET;
const configDirectory = runtime?.sharedRoot || __dirname;
dotenv.config({ path: path.join(configDirectory, '.env') });

// Machine-specific overrides (e.g. PYTHON_BIN=python on Windows dev boxes,
// vs. the python3 that's correct on the Linux production server) — kept in
// a separate, git-ignored file (.env.* is excluded except .env.example) so
// nothing here ever risks shipping to production.
dotenv.config({ path: path.join(configDirectory, '.env.local'), override: true });
if (runtime) {
  // A production .env.local PORT must not make a candidate steal port 5000.
  process.env.PORT = String(runtime.port);
  process.env.MATTER_API_RELEASE = runtime.releaseId;
  process.env.MATTER_API_PORT = String(runtime.port);
  process.env.MATTER_SHARED_SERVER_ROOT = runtime.sharedRoot;
  process.env.MATTER_API_WEB_ONLY = '1';
  process.env.MATTER_API_CONTROL_SOCKET = controlSocket || '';
  process.env.MATTER_RELEASE_SHA = runtime.releaseId.slice(0, 40);
  process.env.MATTER_ACTIVITY_JOURNAL_DIR = path.join(__dirname, '.activity-journal');
}
