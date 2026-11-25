# API handoff without stopping the serving API

This is a prepared, manual-only deployment path. It has not been activated on
production. The owner requested that pause-only PR #230 remain open. Its proposed
trigger removal has therefore not established a live pause. Do not merge, enable
automation or run any of the activation commands below without a separate live
qualification and the owner's authorization.

## Runtime ownership

`Nginx → matter-api-gateway:34999 → selected web API:35000–35999` serves requests.
The gateway is an independent, pinned runtime. Normal releases neither restart
it nor reload Nginx; this avoids interrupting idle client keep-alive connections.
It streams uploads/responses with backpressure, preserves end-to-end headers and
WebSocket upgrades, and never retries a write with an uncertain result.

The existing, single `matter-delivery-api:5000` process keeps scheduled GPS,
tracker, import, reporting-outbox and notifier work running. It is never deleted,
reloaded, scaled or reconfigured by the web handoff. Existing report source and
builder workers retain their own identities and controls. Web candidates set an
explicit managed role that cannot start the business job timers. They share
the existing private `.env`/`.env.local`, uploads and `.private` inputs, but retain
separate activity journals so competing flushers do not claim the same files.
Do not prune a retired release containing a pending journal.

Web deployment does not upgrade this job owner. A change intended for scheduled
job behavior or a new API/job contract requires a separate compatible worker
release plan. Keep schema changes backward-compatible with all retained writers
and readers. No destructive migration or worker-code replacement is performed.

## One-time qualification and setup, not performed by this change

1. Keep the current app serving and automation paused. Confirm its actual Actions
   state; this repository's local manual-only workflow is not proof of live state.
2. Qualify a job-owner baseline containing the readiness fields in this change.
   Require exactly one online `matter-delivery-api` on port 5000, connected MongoDB,
   enabled background jobs, healthy Redis fan-out and ready configured Customer
   Service and Driver Reports connections. An older health response is rejected.
   Installing that initial baseline is a separately approved migration; this code
   does not claim uninterrupted migration from an unqualified legacy process.
3. Verify staff Socket.IO authentication and events across the job owner and a web
   candidate using the same actual Redis adapter. Without this the handoff stops;
   an in-memory-only adapter cannot carry job broadcasts to the new web process.
4. Qualify capacity under representative load. The preflight requires at least
   512 MiB available memory and 1 GiB free disk. With Driver Reports enabled, it
   requires 2 GiB available memory because the retained reader can start a child
   with a 1 GiB heap. These floors are not a load test or an OOM guarantee.
5. From the reviewed checkout as the deployment user, stage the gateway:

   ```bash
   node .github/scripts/api-gateway.mjs prepare /home/matter/matter-delivery-tracker
   ```

   This creates private configuration and an immutable, hashed gateway runtime
   under `.api/`. It does not start a process, change routing or modify `.env`.
   The original target is 5000. Repeating preparation refuses to overwrite it.
   Inspect interrupted state rather than deleting the directory to force a retry.
6. After review, start and save that independent process:

   ```bash
   pm2 start /home/matter/matter-delivery-tracker/.api/gateway-process.private.json
   pm2 save
   ```

   Verify loopback port 34999 forwards to the current job-owner API and the owner-
   private `.api/control/gateway.sock` reports the pinned runtime digest. Control
   operations are available only on that private Unix socket, never over TCP.
7. Back up and inspect the actual Nginx site. Change only the existing API and
   Socket.IO proxy destinations from `127.0.0.1:5000` to `127.0.0.1:34999`, preserving
   the `/api/` and `/socket.io/` suffixes, host/proxy headers, upgrade headers, TLS,
   upload rules and timeouts. Validate with `nginx -t` before the one-time reload.
   Normal releases do not reload Nginx after this setup. Keep the original API
   process running throughout. Verify login, permissions, a saved write, upload,
   a real socket event and unchanged GPS capture before allowing a web handoff.
8. Mirror the website's public build settings into GitHub variables as described
   in [website deployment](../ATOMIC_WEBSITE_DEPLOYMENT.md). The new workflow
   preserves existing server configuration; it does not apply new private secrets,
   seed permissions, change a staff link or select a different reporting store.

If the job-owner baseline, gateway, feature readiness or capacity checks fail,
the candidate workflow stops rather than falling back to delete/start deployment.

## Manual release behavior

The manual workflow creates checksummed website and tracked API-source artifacts
for one commit/run/attempt. On the Droplet, source and `npm ci --omit=dev` are staged
in `.api/releases/COMMIT-RUN-ATTEMPT`, never in the running owner's directory.
The stable checkout is not reset. The candidate uses the existing server working
directory for shared relative data paths and its own immutable module paths.

The operator holds `.api/deploy.lock`, checks the gateway's pinned digest/instance,
starts and saves only the new PM2 web registration, waits for private readiness,
then conditionally switches the gateway from the expected prior port. Requests
capture their target and increment its connection count synchronously before
proxying; a switch acknowledgement cannot miss a request still selecting the
old target. The chosen target is persisted before acknowledgement for restart.

Public health must return that exact release through Nginx before website
publication. A pre-commit failure restores and verifies old routing and the
website where necessary. Any candidate that may have served traffic is drained
before deletion. A rollback that cannot be verified retains both processes and
`pending.json` for an operator; it never guesses which API is serving.

After durable commit, old web sockets are closed so normal clients can reconnect
to the selected release. The operator waits for both gateway connection counts
and API request counts to reach zero before retiring that web process. It never
retires port 5000's job owner. A slow request beyond the bounded wait leaves the
old web process alive and marks `retirementPending`; new releases are blocked.
After the request ends, an authorized operator can finish the same retirement:

```bash
node .api/releases/CURRENT-RELEASE/.github/scripts/api-release.mjs retire "$PWD"
```

Keep the gateway, job owner and candidate saved in PM2. A failure saving final
retirement state is not grounds to kill traffic or silently remove its evidence.
Do not use `pm2 reload all` or update the pinned gateway as an ordinary app release.

## Recovery and acceptance

Inspect `.api/current.json`, `pending.json`, private process files, gateway status
and PM2 before resolving a stale lock, crash or uncertain cutover. Do not publish
a new release over an unresolved pending receipt. Read back the actual routed
release and drain connection counts before any manual stop. Retain release code,
private source records, current/previous website assets, journals, uploads and
report history. This operator contains no archive/data cleanup or forced unlock.

Automatic compensation covers caught failures before commit. Power loss,
SIGKILL, a gateway crash, incompatible database changes and unqualified manual
worker operations require operator recovery. A manual application rollback must
first start and health-check the retained prior web registration, switch the
gateway with the expected current port, verify public health, then drain the
replaced web API. Coordinate website compatibility separately; changing only a
website pointer does not roll back data or the backend. Never stop the job owner
to perform a web rollback.

Local engineering tests cover continuous persistent HTTP reads through real
Nginx, one-time completion of slow writes during handoff and rollback, WebSocket
forwarding/reconnection, a live separate job-process fixture, compare-and-swap
refusal, durable gateway routing, control-socket crash recovery and readiness
configuration isolation. They do not establish live MongoDB/Redis/Customer Service
or report flow. Real staff acceptance must check authenticated reads/writes,
uploads, existing browser sessions, mobile offline sync, actual cross-process
events, fresh GPS records, report evidence and both failure/rollback paths.
