# Keep the website available during deployment

The supplied production Nginx configuration serves `client/build` directly and
falls back to `/index.html`. CRA clears that directory when building. An absent
index can cause an Nginx internal-redirection cycle and an HTML 500. An Nginx
error-log entry from the incident is needed to confirm the exact failure.

Atomic website mode builds in GitHub Actions, verifies a complete artifact, and
switches a Linux symlink only after the existing backend verification succeeds.
Incomplete uploads and failed builds never replace the visible website. An
unsuccessful public website/asset check restores its previous pointer.

This fixes static website publication, not the separate API restart gap. The
existing `pm2 delete`/start sequence and supervised audit-worker pause/resume
remain unchanged. Do not call this a zero-downtime backend deployment. Overlapping
API instances need a separately reviewed background-job and worker ownership
plan, readiness, draining, resource checks and consistent Socket.IO delivery.
Website rollback does not undo a backend deployment or database changes.

## One-time activation after code review

The new workflow path is OFF unless the production environment variable
`ATOMIC_WEBSITE_DEPLOY` is exactly `1`. Keep it unset during preparation. Existing
audit operations retain their existing behavior and do not upload websites.

1. Merge the reviewed changes with the new mode still off. The legacy deployment
   still runs at this stage, with its existing interruptions. Wait for it to finish;
   do not bootstrap while another deployment is building the old directory.
2. From the production app directory as its deployment user, snapshot the complete
   currently working build without changing its source or Nginx:

   ```bash
   cd /home/matter/matter-delivery-tracker
   node .github/scripts/website-release.mjs bootstrap "$PWD"
   ```

   This creates `.website/current`, `.website/releases/bootstrap-TIMESTAMP` and
   `.website/legacy-static`. A bootstrap runs only once. Never replace an existing
   pointer manually with a directory. A failed bootstrap leaves the original
   `client/build` untouched; inspect its private deployment directories before retry.
3. Back up the active production Nginx site file identified by `nginx -T`. In the
   existing HTTPS `server` block, replace only the website root with:

   ```nginx
   root /home/matter/matter-delivery-tracker/.website/current;
   ```

   Add these two locations alongside the existing `/`, `/api/`, `/uploads/` and
   `/socket.io/` locations. Keep all existing TLS, security, API, upload and socket
   settings. The aliases contain only public website assets, never server files.

   ```nginx
   location ^~ /website-releases/ {
       alias /home/matter/matter-delivery-tracker/.website/releases/;
   }

   location ^~ /static/ {
       alias /home/matter/matter-delivery-tracker/.website/legacy-static/;
   }
   ```

   The first route retains versioned bundles for existing tabs; the second retains
   the pre-migration bundles. Neither falls back to HTML for a missing JS asset.
4. Run `sudo nginx -t`, and reload Nginx only if it passes. Verify:

   ```bash
   node .github/scripts/website-release.mjs check "$PWD/.website/current" https://matterapp.online
   ```

   Confirm a fresh browser login, an already-open page, and the driver offline
   workflow. Node HTTP checks do not run a browser or its service worker. If this
   check fails, restore the saved Nginx configuration and reload after validating;
   keep atomic mode off. Both the old build and the bootstrap snapshot remain.
5. Mirror the previous client `.env*` build settings into production GitHub
   environment **variables** before moving builds. Supported names are explicitly
   listed in the website-build step (`REACT_APP_*`). They are embedded in browser
   code: use public, appropriately restricted map keys, not server secrets.
   Verify 2GIS, API/socket origins, timezone/next-day settings and meal-selection
   feature switches against the existing site; empty values can select defaults.
6. Set production environment variable `ATOMIC_WEBSITE_DEPLOY=1`. Run a manual
   `deploy` for the reviewed current main commit. Future deploys build on the
   runner and upload checksummed artifacts before changing server code. A public
   preflight must confirm Nginx is already serving `.website/current`; otherwise
   the deploy stops before pausing workers or replacing application code.

Do not enable the variable first or point Nginx at an empty directory. No Nginx
edits, production commands, migrations or deployments are performed by this PR.
Once bootstrapped, legacy deploys stop before application changes until activation
is completed. To return to legacy deployment, first restore the original Nginx
root and remove the two release locations, validate and reload Nginx, then move
the `.website/current` symlink aside and set the variable to `0`. Merely disabling
the variable would otherwise leave Nginx serving a frozen snapshot.

## Rollback and operation

For a website-only rollback from the production app directory:

```bash
node .github/scripts/website-release.mjs rollback "$PWD"
node .github/scripts/website-release.mjs check "$PWD/.website/current" https://matterapp.online
```

Releases are immutable and include source commit, run ID and attempt in their
URLs. Re-running an old source commit produces a different URL. The publisher
rejects bad manifests, unexpected files, symlinks, missing assets and checksum
mismatches. Concurrent publishers fail closed using `.website/publish.lock`.
If the host dies during publication, inspect the lock/current/previous state
before an operator removes a stale lock; the workflow never force-unlocks it.

Monitor disk space: releases and incoming uploads are retained for diagnosis,
rollback and older browser sessions. No automated prune deletes them. Review a
retention policy before removing old assets; never delete `current`, `previous`,
the bootstrap release used by `legacy-static`, or assets needed by supported
offline clients. A backend-incompatible website rollback needs application review.

Linux publisher checks run in `.github/workflows/website-release-checks.yml`
without production credentials, external-service calls or database access. They verify complete
artifacts, original-file preservation, repeated reads across the symlink switch,
asset retention, failed-public-check rollback and concurrent-publication refusal.
Windows runs the portable integrity checks; Linux publication checks run on CI.
The Linux job also starts an isolated Nginx process on a local test port and
verifies the supplied SPA fallback and alias routes without production access.
