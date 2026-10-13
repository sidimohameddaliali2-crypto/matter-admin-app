# AGENTS.md

Guidance for working in this repo. MATTER is a meal-subscription business in Dubai; this app runs its delivery operations: dispatch, driver app, bag tracking, kitchen lists, menus, partner/member ordering portals, and integrations with the Matter platform and several third-party systems.

## Layout

```
server/   Express + Mongoose API (ES modules, "type": "module"), Socket.IO, background jobs
client/   React 19 SPA (Create React App / react-scripts), Redux Toolkit, Tailwind + MUI
docs/     Current integration docs (external delivery API, Matter API, Postgres migration plan)
.github/workflows/deploy-digitalocean.yml   Deploys on every push to main
```

The root-level `*.md` files (OFFLINE_SYNC_*, PERFORMANCE_*, etc.) are historical feature write-ups from past work sessions. They are often stale: trust the code over them, and don't add more of them.

## Commands

Server (from `server/`):
- `npm run dev`: nodemon on `server.js`, port 5000 by default.
- `npm start`: production start (this is what PM2 runs).
- `npm test`: `node --test`, which picks up `services/*.test.js` (handoffPlanner, matterApiService, matterDeliveryImportService, poiService, routeOptimizationService). The tests are pure fixtures, with no DB or network.
- Run one test file: `node --test services/handoffPlanner.test.js`
- `npm run create-admin`: seeds an admin user. `scripts/createSuperAdmin.js` seeds a super admin.

Client (from `client/`):
- `npm start`: CRA dev server on port 3000. `utils/api.js` targets `http://localhost:5000/api` when the host is localhost, and otherwise `${origin}/api`. `REACT_APP_API_URL` overrides this.
- `npm run build`: outputs to `client/build/`, which Express serves statically along with the SPA fallback.
- `vite.config.js` and `main.jsx` are unused leftovers. The real toolchain is react-scripts, and components use JSX in `.js` files.

The route optimizer needs Python with `ortools` (`server/optimizer/requirements.txt`). On Windows, set `PYTHON_BIN=python` in `server/.env.local`. See `server/optimizer/OSRM_SETUP.md` for the self-hosted OSRM (Docker, port 5001).

## Environment

- `server/loadEnv.js` must remain the first import in `server.js`. ESM evaluates every import before the importing file's own code, so any module that reads `process.env` at the top level would otherwise capture `undefined`. It loads `server/.env` first and then `server/.env.local` as an override.
- `.env*` files and `server/ecosystem.config.cjs` are git-ignored because they contain secrets. There is no `.env.example` yet. `ecosystem.config.example.cjs` is the only template.
- Required: `MONGODB_URI` and `JWT_SECRET`. Most integrations are optional and turn off when their env vars are missing, including Redis (`REDIS_URL`), DigitalOcean Spaces (`SPACES_*`), Slack (`SLACK_*`, `ENABLE_SLACK_NOTIFICATIONS`), and the Matter import.
- Business time is Dubai (UTC+4). Use `LOCAL_TIMEZONE_OFFSET_MINUTES` (default 240) and `BUSINESS_TZ_OFFSET_MINUTES` for day boundaries. Don't rely on the server's TZ.

## Server architecture

- `server.js` mounts every router under `/api/*`. Add a new router there. Routes are fat: most business logic lives directly in `routes/*.js`, and `routes/deliveries.js` and `routes/menus.js` each run to several thousand lines. Reusable logic belongs in `services/`.
- Models are in `models/`. The core ones are `Delivery` (`type`: Delivery/Task/Collection; `status`: pending → assigned → on_route/picked_up → delivered/completed/collected/failed), `Customer`, `User`, `Bag`, `WeeklyMenu`/`MenuItem`/`MenuSelectionRecord`, `Partner`/`SpaceOrder`/`OrderLine`, and `Member`/`MemberOrder`/`MemberOrderLine`.
- Auth uses four separate schemes. Don't mix them:
  - Staff: JWT Bearer via `middleware/auth.js`, providing `protect`, `authorize([...roles])`, the `admin`/`manager`/`dispatcher`/`superAdmin` shortcuts, and `checkPermission(key)`. The roles are super_admin, admin, manager, dispatcher, driver, store_keeper, viewer, yellowblock_user, and kitchen. Per-user `permissions` fall back to role defaults defined in `models/User.js`, and the client gates pages on the same permission keys (`PermissionBasedRoute` in `client/src/App.js`).
  - Partners: `middleware/partnerAuth.js` (`/api/partner/*`).
  - Members: `middleware/memberAuth.js`, which is passwordless. It sets both `req.member` and `req.partner` so partner handlers can be reused.
  - External read-only API: static API keys via `middleware/apiKeyAuth.js` (`DELIVERY_API_KEYS`), mounted at `/api/external/deliveries`. Docs are in `docs/EXTERNAL_DELIVERY_API.md`.
- Real-time updates: routes emit through `req.app.get('io')`, with events such as `delivery:created`, `delivery:updated`, and `deliveries:deleted`. Drivers join the `driver:<id>` rooms. When Redis is available, the Socket.IO Redis adapter carries broadcasts across PM2 instances.
- Caching goes through `config/cache.js` (`cacheGet`/`cacheSet`/`cacheDelete`). Everything must keep working when Redis is down, because the helpers no-op.
- File uploads use multer and `middleware/compressImage.js` (sharp). Files go to DigitalOcean Spaces (`config/spaces.js`) when that's configured, and to `server/uploads/` otherwise.
- Background jobs (`jobs/`) start from `server.js` as setTimeout-then-daily-setInterval: flagged-customer notifier, move uncollected collections, recalculate driver KPIs (see `services/driverKpiService.js`), and import Matter deliveries.
- Areas: `config/areas.js` (`detectAreaFromAddress`) maps addresses to delivery areas. The other `areas-*.js` files are backups and experiments.

## External integrations (`server/services/`)

- Matter platform API (`matterApiService.js`, `MATTER_API_*`): subscriptions, nutrition and macros, and pause writes. `matterDeliveryImportService.js` plus `jobs/importMatterDeliveries.js` create the day's `Delivery` docs from Matter subscriptions, keyed by `matterSubscriptionId`.
- Athleat / FileMaker (`athleatService.js`): the legacy FileMaker Data API for customers and orders, which the app is migrating away from. The many `server/test*.js`, `get*.js`, and `search*.js` files at the server root are ad-hoc FileMaker/Matter debugging scripts, not part of the app.
- Maps and geo: automatic Google geocoding is OFF (owner, 2026-10-12): `resolveDeliveryCoordinatesCached` (`geocoding.js`) only returns a pin that already exists (the delivery's own, a Google Maps link, or the customer's saved `Customer.gpsLocation` for that exact address) and never guesses or writes one, so unpinned deliveries wait for a dispatcher. Google is still called only by the explicit "Google Geocoding" button (`POST /deliveries/geocode-google`). OSRM supplies distance matrices (`distanceMatrixService.js`). The dispatcher route maps use 2GIS MapGL (`@2gis/mapgl`, which takes coordinates as `[lng, lat]`). Don't add Google Maps JS to new views.
- Route optimization: `routeOptimizationService.js` spawns `optimizer/solve_routes.py` (OR-Tools). `handoffPlanner.js` plans van ↔ bike handoffs.
- Other integrations: Supy recipes (`supyService.js`, with a cache warmed at startup), Xero invoicing, Truckoom fleet, Slack (`slackNotifier.js`, `slackEventService.js`), Brevo email (`emailService.js`), Expo push, Gallabox WhatsApp, and Shopify.

## Client architecture

- Routing and role guards live in `src/App.js` (`ProtectedRoute`, `RoleBasedRoute`, `PermissionBasedRoute`, `PartnerRoute`, `MemberRoute`). Pages are in `src/pages/`, and many are single large files. `DriverMobile.js` alone is about 5.5k lines.
- State uses Redux Toolkit slices in `src/store/slices/`. Partner and member auth have their own slices, plus their own API clients (`utils/partnerApi.js`, `utils/memberApi.js`) alongside the staff `utils/api.js`.
- Socket.IO client: `contexts/SocketContext.js`.
- The driver app works offline. `public/service-worker.js`, `utils/offlineStorage.js`, `utils/offlineSync.js`, and `hooks/useSyncStatus.js` queue status updates and photos while offline. Keep driver-facing changes offline-safe and mobile-first.
- Public customer flows: `/menu-select/:token` (menu selection link, with components in `components/menuSelectionLink/`) and `/join/:token` (member registration).
- The partner and member portals use the MATTER dark/lime brand styling.

## Deployment

Every push to `main` triggers the GitHub Action, which SSHes into the DigitalOcean droplet. There it runs `git reset --hard origin/main`, installs server deps with `npm ci --omit=dev`, runs `npm ci && npm run build` for the client, and restarts PM2 as `matter-delivery-api`. Merging to main means shipping to production, so make sure the client builds before you push.

## Conventions

- Server code uses ESM imports, including the `.js` extension on relative paths.
- Responses usually look like `{ success, message, data }`. Validation uses `express-validator`.
- Comments often record the owner's request and the date behind non-obvious behavior (e.g. "Owner (2026-09-22): ..."). Keep that context when you edit such code.
- Git-ignored paths: `client/build/`, `server/uploads/`, `tmp/`, and logs.
