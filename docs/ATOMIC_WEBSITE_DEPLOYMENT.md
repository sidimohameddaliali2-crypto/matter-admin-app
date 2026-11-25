# Keep the website available during deployment

Production Nginx serves `client/build` and falls back to `/index.html`. CRA clears
its output directory when building. Building there can remove the live index and
cause an Nginx internal-redirection cycle and an HTML 500. An error-log entry is
still needed to attribute any individual production incident to that condition.

## Default deployment: keep the existing Nginx configuration

The candidate workflow is **manual-only**: no push trigger is present. The pause
change is also proposed separately in PR #230; leaving that PR open does not
apply a pause to the live workflow. Do not describe production as paused without
checking its actual Actions configuration. This branch has not been deployed.

Every manual application deployment builds and seals the website in GitHub Actions,
uploads a checksummed artifact, and verifies it before changing application code.
The Droplet never runs CRA in the live directory. No Nginx edit, bootstrap command
or feature-variable activation is required for the existing `client/build` root.

Before merging, mirror the previous client `.env*` build settings into production
GitHub environment **variables**. The supported `REACT_APP_*` names are listed in
the website-build step. They are embedded in browser code; use restricted public
map keys, never server credentials. Compare API/socket origins, 2GIS, timezone,
next-day rules and meal-selection switches with the current site. Empty variables
can select defaults. The runner cannot read private `.env` files on the Droplet.

With `ATOMIC_WEBSITE_DEPLOY` unset or `0`, the publisher:

1. Copies the verified build to `.website/releases/COMMIT-RUN-ATTEMPT` and adds
   `client/build/website-releases` as a link to that public release directory.
   Existing files at that path cause a safe failure rather than being overwritten.
2. Fetches the candidate HTML and main bundle through the public website, comparing
   exact hashes. A wrong Nginx root, blocked symlink or HTML fallback fails before
   worker pauses, code changes or visible website publication.
3. Leaves the current website and all original `/static/` files intact while the
   API deployment runs. No client dependencies are installed on the Droplet.
4. Starts the isolated web API, verifies database, Redis and configured feature
   readiness, then switches the stable local gateway without restarting Nginx
   or the job owner. See [API handoff and qualification](deployment/API_HANDOFF.md).
5. Replaces public compatibility files using atomic same-directory renames, with `index.html`
   last. New HTML refers to immutable `/website-releases/COMMIT-RUN-ATTEMPT/` assets.
   Old tabs can still retrieve their old assets. A failed public marker, HTML or
   main-bundle check restores the previous public files and preserves the existing
   rollback target. An identical retry does not replace that target.

A build/upload/API-readiness failure does not replace the visible website. A
public post-publication failure can briefly expose the complete candidate before
restoring the prior shell. Individual entry-file replacements are atomic; the
set of manifest/service-worker/index files is not one filesystem transaction.
Hard-coded public image/icon URLs are updated too; files no longer in a candidate
are retained so previously loaded clients can still access them.

API releases now have independent code and dependencies. The old web process
remains until both the gateway and API report no active requests/connections.
An automatic rollback also drains a candidate that already received traffic.
Existing WebSockets can reconnect to the selected release during retirement;
this is not a promise that a socket transport never reconnects. No API change
restarts scheduled GPS/import work. Worker upgrades are separately qualified.
The candidate needs the one-time gateway/job-owner setup before it can run;
fixture tests are not production acceptance. Website-only rollback does not undo
API code, database writes or private configuration changes.

## Website rollback

For the default Nginx root, run as the deployment user from the production app
directory, after ensuring no deployment is in progress:

```bash
cd /home/matter/matter-delivery-tracker
node .github/scripts/website-release.mjs rollback-live "$PWD"
```

This restores the root files saved at the last successful publication. Confirm
the website, its referenced main bundle, fresh login, an existing open page and
the driver offline journey. HTTP fixtures do not certify browser/SW acceptance.

## Existing symlink-root installations

Keep `ATOMIC_WEBSITE_DEPLOY=1` if Nginx already uses `.website/current`. That mode
continues to use the original symlink publisher and rollback pointer. Its public
preflight must pass before application changes. Do not disable it while Nginx
still uses that root: the default publisher targets `client/build`, not that
symlink. Its candidate asset checks must pass for the unchanged root to be usable.

The required existing locations are:

```nginx
root /home/matter/matter-delivery-tracker/.website/current;
location ^~ /website-releases/ {
    alias /home/matter/matter-delivery-tracker/.website/releases/;
}
location ^~ /static/ {
    alias /home/matter/matter-delivery-tracker/.website/legacy-static/;
}
```

Keep all TLS, API, upload and Socket.IO settings. A fresh symlink-root installation
is optional: first run `bootstrap "$PWD"`, validate and reload the reviewed Nginx
configuration, run `check "$PWD/.website/current" https://matterapp.online`, and
only then set the variable to `1`. Default installations need none of these steps.
Its website rollback remains:

```bash
node .github/scripts/website-release.mjs rollback "$PWD"
node .github/scripts/website-release.mjs check "$PWD/.website/current" https://matterapp.online
```

## Recovery, retention and verification

Publishers fail closed on a concurrent `.website/publish.lock`. A killed host or
publisher can leave that lock and partially updated entry files. Inspect the
saved `live-previous.json` or symlink `current`/`previous` state before an operator
removes a stale lock and restores the last verified release. Automatic rollback
handles caught publication errors, not host loss or SIGKILL.

Monitor disk space: releases and incoming uploads are retained for diagnosis,
rollback and existing/offline browser sessions. No automated prune deletes them.
Review retention before removing assets; never remove a referenced release,
the default root's original static files or a bootstrap used by `legacy-static`.

`.github/workflows/website-release-checks.yml` runs Linux integrity, API-readiness
and real Nginx tests without production credentials or database access. Continuous
requests exercise the unchanged SPA root through prepare, publish, a failed health
check and rollback, including old-tab bundles. Local client builds separately
validate CRA's release-prefixed output. Live activation remains a production
acceptance step; fixture tests do not establish the serving host's configuration.
