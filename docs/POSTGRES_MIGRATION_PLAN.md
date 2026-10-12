# MongoDB → PostgreSQL migration plan

A step-by-step plan to move this app's database from MongoDB to PostgreSQL.
Written as a reference to execute against, not a one-sitting task — expect
several weeks of focused work. Each phase is independently checkable before
moving to the next; don't start a phase until the previous one's
verification passes.

**Status when this was written:** Phase 1 (audit) is done and Phase 2's
schema draft exists. Nothing has been migrated yet — MongoDB is still the
live database.

## Why this plan exists

MongoDB has no enforced foreign keys or uniqueness beyond single-field
indexes — the duplicate-customer, orphaned-selection and shadowed-record
bugs fixed earlier are a direct consequence of that, caught by app-code
discipline and one-off scripts rather than the database itself. Postgres
makes that class of bug structurally harder: a `NOT NULL` foreign key simply
rejects an orphaned write at insert time. That's the entire reason to do
this — not performance, not "scale" (see the scaling discussion elsewhere;
MongoDB scales fine for this app's traffic shape).

## Decision gate — confirm before starting

This is a multi-week rewrite touching nearly every route file. Before
starting Phase 3 (the actual code rewrite), confirm:
- [ ] The data-integrity bugs this is meant to prevent have stopped
      recurring with the current service-layer discipline (if they haven't,
      that's the real signal to proceed)
- [ ] You can accept a maintenance window for the final cutover (deploys to
      `main` go straight to production per `.github/workflows/deploy-digitalocean.yml`)
- [ ] One developer can dedicate sustained time to this — partial, stop-start
      migrations are where data gets lost

---

## Phase 1 — Data audit (done)

**Script:** `server/scripts/auditMongoForSqlMigration.js` — read-only,
re-runnable any time to see current state. Last run found:

- **17 blockers** that would reject a load into the Phase 2 schema as-is,
  including: 234 selections with no customer link, 1 duplicate
  `matterSubscriptionId`, dangling references from deliveries/delivery
  changes/selections to deleted customers/menus/menu items, and 101
  duplicate `(weeklyMenuId, email)` selection pairs.
- **7 warnings**: unparseable numeric strings (`amountPaid: "1,552.00"`,
  `discount: "10.00%"`), `menuitems.carbs` holding a dish name instead of a
  number, customers with neither email nor Matter subscription id.
- Full detail: `server/scripts/output/mongo-sql-audit.json`.

**Action before Phase 4 (ETL):** re-run the audit and get it to zero
blockers. Some (the 234 unlinked selections) need the same merge pattern
already used for the throwaway-customer cleanup; others (dangling refs to
deleted menus/items) just need a decision — null the reference, or restore
the deleted record.

**Verification:** `node server/scripts/auditMongoForSqlMigration.js` reports
0 blockers.

---

## Phase 2 — Schema (drafted)

**File:** `server/db/schema.sql` — already applies cleanly to a real
Postgres 16 instance (verified via a throwaway Docker container), 31 tables
covering customers, deliveries, menus/kitchen, and menu selections.

**Still needed:**
- Expand the 4 stub tables (`users`, `partners`, `bags`, `handoffs` — currently
  minimal, just enough for foreign keys to resolve) into their full schemas,
  following the same pattern as the completed domains: flatten embedded
  arrays into child tables, Maps into keyed tables, enums into `CHECK`
  constraints.
- Add any tables not yet covered: `employees`, `vehicles`, `fuel_logs`,
  `incidents`, `leave_requests`, `events` + its child tables,
  `yellowblock_assets` + usages, `communications`, `slack_logs`,
  `webhook_events`, `flagged_alerts`, `xero_tokens`.

**Verification:** apply the full schema to a fresh Postgres instance (reuse
the Docker throwaway-container pattern from Phase 2's first draft) and
confirm it creates cleanly with no errors.

---

## Phase 3 — Infrastructure

1. Provision a managed Postgres instance (DigitalOcean Managed Databases
   fits the existing droplet setup).
2. Add `DATABASE_URL` to `server/.env` (git-ignored, same pattern as
   `MONGODB_URI`), and `.env.local` for any local override.
3. Install the query layer: **Drizzle ORM** + `pg` driver (recommended over
   Prisma — stays close to real SQL, which matters for the joins/aggregates
   this app's reports need; see the query-layer discussion for the full
   reasoning).
4. Set up Drizzle's migration tooling against the Phase 2 schema, so schema
   changes going forward are versioned migrations, not hand-edited SQL.
5. Confirm automated backups are on and do one test restore before loading
   any real data.

**Verification:** `drizzle-kit` can introspect the empty schema; a trivial
read/write round-trips from a throwaway Node script.

---

## Phase 4 — ETL script

Write one idempotent, re-runnable script (`server/scripts/migrate-to-postgres.js`),
not a one-shot — it will be run multiple times during development and dry
runs.

**Load order** (parents before children, matching the FK graph):
1. `users`, `partners`, `bags`, `vehicles`, `employees` (no dependencies)
2. `customers` (depends on `partners`)
3. `menu_items`, `weekly_menus` (depends on `users`)
4. `weekly_menu_items`, `menu_day_options`, `menu_breakfast_presets`
5. `menu_selections`, `menu_selection_meals`, `menu_selection_day_notes`,
   `menu_selection_skipped_days` (depends on `customers`, `weekly_menus`,
   `menu_items`)
6. `deliveries` and all its child tables (depends on `customers`, `users`,
   `handoffs`)
7. Everything else (partner orders, invoices, events, yellowblock, etc.)

**Pattern per table:**
- Read from Mongo in batches (reuse the `mapWithConcurrency` helper already
  used in the diagnostic scripts).
- Map `_id` → a new `mongo_id` column on every Postgres table (keep this
  column permanently — it's the audit trail and the rollback key).
- Insert via Drizzle, catching and logging constraint violations rather than
  crashing the whole run (same pattern as `migrate-customer-ref.js`'s
  try/catch around `bulkWrite`).
- Print a per-table summary: source count, loaded count, skipped count with
  reasons.

**Verification:** row counts per table match Mongo's collection counts minus
the deliberately-skipped blockers from Phase 1; spot-check 10 random
customers' full selection history renders identically via a throwaway
read script against both databases.

---

## Phase 5 — Service layer (the real rewrite)

This is the bulk of the effort. Current state: routes call Mongoose
directly — `menus.js` has ~89 Mongoose calls, `deliveries.js` ~73,
`adminPartners.js` ~58, plus `partnerPortal.js`, `bags.js`, `employees.js`,
`drivers.js`, `deliveryChanges.js`. About 108 `.populate()` calls need to
become joins, about 24 `.aggregate()` calls need to become `GROUP BY`/window
functions.

**Approach — migrate one domain at a time, in this order (lowest risk/blast
radius first):**

1. **Yellowblock + Events** — small, self-contained, no other domain depends
   on it.
2. **HR/Fleet** — `employees`, `vehicles`, `fuel_logs`, `incidents`,
   `leave_requests`. Internal-only, low traffic.
3. **Partners, Members, Finance** — `partners`, `members`, `space_orders`,
   `member_orders`, `invoices`, `waste_logs`. Moderate complexity, bounded
   blast radius (partner portal, not the driver app).
4. **Menus/Kitchen** — `menu_items`, `weekly_menus`, `menu_selections` and
   children. Higher traffic (Kitchen List/Counting), but well understood
   after this session's performance work.
5. **Customers** — the join target for almost everything else; migrate
   after the domains that reference it are already stable, so you're not
   chasing a moving target.
6. **Deliveries + Bags** — last, and most carefully: the offline-capable
   driver app depends on this data, and it's the highest-traffic domain.

**For each domain:**
- Create a `services/<domain>PgService.js` alongside the existing Mongoose
  calls — don't delete the Mongoose code yet.
- Rewrite each route in that domain to call the new service.
- Add an env-gated switch (`USE_PG_FOR_<DOMAIN>=true`) so a domain can be
  flipped back to Mongo instantly if something's wrong, without a redeploy.
- Write integration tests against a real Postgres (Docker, same pattern used
  to validate `schema.sql`) for every route touched — there's currently no
  route-level test coverage, only `services/*.test.js` fixtures, so this is
  new test infrastructure, not just new tests.

**Verification per domain:** every route in that domain has a passing
integration test; manual smoke test in the actual UI (the relevant admin
page, partner portal, or driver app screen) with the flag on; no behavior
change visible to the end user.

---

## Phase 6 — Dual-run verification

Before flipping a domain's flag on in production:
1. Run both Mongo and Postgres code paths side-by-side in a staging
   environment for real traffic (or a replayed sample of it) for at least a
   few days.
2. Diff the responses — log mismatches, don't just assert they're equal and
   move on. A mismatch here is cheaper to find now than after cutover.
3. Fix discrepancies (usually: a join that's slightly different from a
   `.populate()`'s default sort order, or a null-handling edge case).

**Verification:** zero unexplained mismatches over the dual-run window.

---

## Phase 7 — Cutover

1. Flip the env flag for one domain in production, off-peak hours.
2. Watch error rates and the relevant UI closely for the first hour.
3. Keep the Mongo code path and data in place for at least one full billing
   cycle after cutover — this is your rollback.
4. Repeat per domain until all are migrated.
5. Only after every domain is stable on Postgres for a few weeks: remove the
   Mongoose code paths, drop the `mongo_id` columns if truly unneeded (most
   teams keep them permanently as an audit trail — cheap to keep, useful if
   anything is ever questioned), and decommission the MongoDB instance.

**Verification:** a full week with zero rollbacks and no Mongo code paths
invoked (log this explicitly, don't just assume).

---

## Critical files

- `server/scripts/auditMongoForSqlMigration.js` — read-only, re-run anytime
- `server/db/schema.sql` — the schema, needs the 4 stub tables expanded
- `server/scripts/migrate-to-postgres.js` — new, the ETL script (Phase 4)
- `server/routes/*.js`, `server/services/*.js` — the rewrite surface (Phase 5)
- `server/models/*.js` — stays as reference for field semantics during the
  rewrite; don't delete until Phase 7 is fully done

## What this plan deliberately does not cover

- A specific timeline — effort depends entirely on how much the fat routes
  resist being split into services first; that's worth doing as prep work
  regardless of whether this migration proceeds.
- Which ORM alternative to Drizzle you could use instead (Prisma, Knex, raw
  `pg`) — covered in the earlier query-layer discussion, not repeated here.
- Rewriting the event/integration layer (Slack and other integrations) — that's
  an orthogonal architecture change (see the "connecting more tools"
  discussion) and isn't blocked by or blocking this migration.
