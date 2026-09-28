# API Reference

In **production** (after `npm run build && npm start`) the Express server at port 3000 serves both the API and the React client. Access from any browser on the LAN via `http://[server-ip]:3000`.

In **development** (`npm run dev`) the Vite dev server at port 5173 proxies all `/api/*` requests to port 3000.

All request bodies are JSON (`Content-Type: application/json`) unless noted otherwise. All responses are JSON. Timestamps are Unix epoch milliseconds.

**Authentication:** every route below requires a signed-in session cookie or an `Authorization: Bearer <api_key>` header, except `GET /api/health` and the routes under Auth marked public. See [docs/auth.md](auth.md) for the full model. An unauthenticated request gets `401 { "error": "Not authenticated" }`.

---

## Health

### `GET /api/health`

Public, no authentication required.

```json
{ "status": "ok", "timestamp": 1774903214349 }
```

---

## Auth

Full model, OIDC configuration, and the bootstrap/login/session flow: [docs/auth.md](auth.md). `status`, `bootstrap`, `login`, `logout`, `oidc/login`, and `oidc/callback` are public; `me` requires auth.

### `GET /api/auth/status`

Public.

```json
{ "needsBootstrap": false, "oidcEnabled": true, "autoSsoRedirect": false }
```

`autoSsoRedirect` is the `auto_sso_redirect` setting AND `oidcEnabled`: it is always `false` if OIDC isn't actually configured, regardless of the raw setting value, so the client never redirects into a login flow that 404s. See [docs/auth.md](auth.md).

### `POST /api/auth/bootstrap`

Public, but only accepted while zero users exist (`403` otherwise). Creates the first account, always as `admin`, and signs it in.

**Body:** `{ "email": "...", "name": "...", "password": "..." }`, all required, password minimum 8 characters.

Returns `201` with the created user (no `password_hash`) and sets the session cookie. `400` on a missing field or a short password.

### `POST /api/auth/login`

Public.

**Body:** `{ "email": "...", "password": "..." }`

Returns `200` with the user and sets the session cookie. `401 { "error": "Invalid email or password" }` on any mismatch (unknown email and wrong password are indistinguishable on purpose). `403 { "error": "This account is pending approval from an operator or admin." }` for a correct password on an unapproved account (see `require_uploader_approval` in Settings and [docs/auth.md](auth.md)); no cookie is set.

### `POST /api/auth/logout`

Public (reads whatever session cookie the request carries, if any). Deletes the session row and clears the cookie. Always returns `200 { "ok": true }`.

### `GET /api/auth/me`

Requires auth. Returns the current user, resolved from either the session cookie or an API key. `401` if neither is valid.

### `GET /api/auth/oidc/login`

Public. Redirects to the configured OIDC provider. `404 { "error": "OIDC is not configured on this server" }` if the `OIDC_*` environment variables aren't set.

### `GET /api/auth/oidc/callback`

Public. This is the redirect target the IdP calls back to: exchanges the authorization code, resolves or provisions a local user (always as `uploader` when newly provisioned; see [docs/auth.md](auth.md)), sets the session cookie, and redirects to `/`. Returns a plain-text `400` or `502` on an expired/invalid flow or an IdP error, rather than JSON, since this endpoint is only ever reached via browser redirect, never called directly by the client. `403` with a plain-text explanation instead of a redirect if the newly (or previously) provisioned account is unapproved (`require_uploader_approval`; see [docs/auth.md](auth.md)); no session cookie is set.

---

## Users

Admin only (`403` for an operator or uploader, including a well-formed session), except the two pending-approval routes below, which an operator can also reach. See [docs/auth.md](auth.md) for the role model and the account approval workflow.

### `GET /api/users`

Admin only.

```json
[{ "id": 1, "email": "joel@farm.local", "name": "Joel", "role": "admin", "approved": 1, "oidc_subject": null, "created_at": 1774903214349, "last_login_at": 1774903214349 }]
```

### `GET /api/users/pending`

Admin or operator. Lists every account with `approved = 0`, a narrower projection than `GET /api/users` above (`id`, `email`, `name`, `role`, `created_at` only):

```json
[{ "id": 5, "email": "new@farm.local", "name": "New Person", "role": "uploader", "created_at": 1774903214349 }]
```

### `POST /api/users/:id/approve`

Admin or operator. Sets `approved = 1`. `404` if not found. Idempotent: approving an already-approved account is a `200` no-op, not an error.

### `POST /api/users`

Admin only. **Body:** `{ "email": "...", "name": "...", "role": "uploader", "password": "..." }`, `email` and `name` required, `role` defaults to `uploader`, `password` is optional (omit for an SSO-only account). Returns `201`, `400` on a bad role or a short password, `409` if the email already exists. Always created `approved: 1` regardless of role: the account approval workflow only gates an account that appears on its own via OIDC, not one an admin creates directly.

### `PUT /api/users/:id`

Admin only. Partial update (`COALESCE`, omitted fields unchanged). **Body:** any of `name`, `role`, `password`, `approved` (boolean), `requires_print_approval` (boolean). `404` if not found, `409` if this would demote the last remaining admin to any other role. `requires_print_approval` is unrelated to `approved`: it gates whether *this account's own G-code uploads* need review before dispatch (`POST /api/gcodes/upload`, `POST /api/gcodes/:id/approve`), not whether the account itself can sign in; see [docs/auth.md](auth.md)'s Print approval section.

### `DELETE /api/users/:id`

Admin only. `404` if not found, `409` if deleting your own currently-signed-in account or the last remaining admin. On success, also deletes that user's sessions and API keys.

`POST` and `PUT` also accept `user_group_id` (a `user_groups.id`; `PUT` accepts `null` to detach). A group decides the account's role: sending a `role` that contradicts the group is a `400`, an unknown group is a `400`, and `PUT` refuses with `409` to move the last admin into a non-admin group. Without a group, a new account joins the built-in group matching its role. User rows include `user_group_id`.

---

## User groups

See [docs/auth.md](auth.md#user-groups) for the model.

### `GET /api/user-groups`

Any signed-in user. Built-in groups first, then custom groups.

```json
[{ "id": 4, "name": "Students", "role": "uploader", "can_approve": 0, "can_set_ready": 0, "can_manage_printers": 0,
   "can_quick_print": 1, "requires_approval": 1,
   "allowed_printer_ids": [1, 2], "allowed_printer_groups": ["Rack A"], "is_system": 0, "member_count": 3, "created_at": 1774903214349 }]
```

`allowed_printer_ids` and `allowed_printer_groups` are `null` when unrestricted.

### `POST /api/user-groups`

Admin only. **Body:** `name` (required, unique, case-insensitive), `role` (`uploader` default, or `operator`), any of the five boolean flags (defaults follow the role), `allowed_printer_ids` (integers), `allowed_printer_groups` (names). An empty array or `null` means unrestricted. Returns `201`, `400` on a missing name, bad role, or bad list, `409` on a duplicate name.

### `PUT /api/user-groups/:id`

Admin only. Partial update: omitted fields are unchanged, and `null` on either printer list clears it. Changing a custom group's `role` also updates its non-admin members. `404` if not found, `409` for the Admin group, or renaming or re-roling a built-in group.

### `DELETE /api/user-groups/:id`

Admin only. `404` if not found, `409` for a built-in group or one that still has members.

---

## API Keys

Self-service: every route operates on the signed-in user's own keys, except deletion, which an admin may also do to someone else's key. See [docs/auth.md](auth.md).

### `GET /api/api-keys`

Returns the current user's keys. `key_hash` is never included.

```json
[{ "id": 1, "name": "OrcaSlicer", "key_prefix": "pfm_ab12cd34", "created_at": 1774903214349, "last_used_at": 1774903214349, "revoked_at": null }]
```

### `POST /api/api-keys`

**Body:** `{ "name": "..." }`. Returns `201` with the full plaintext key in the `key` field, the only time it is ever available; the client must show it once and cannot retrieve it again.

### `DELETE /api/api-keys/:id`

Revokes (soft delete, the row and its `last_used_at` history are kept). `404` if not found, `403` if it belongs to someone else and you aren't an admin.

---

## Account

Self-service actions on the signed-in user's own account, distinct from the `Users` section above (admin managing everyone).

### `PUT /api/account/password`

Change your own password. **Body:** `{ "current_password": "...", "new_password": "..." }`, both required. `401` if `current_password` is wrong. `400` if `new_password` is under 8 characters, or if the account has no password to change at all (SSO-only, `password_hash` is null): `{ "error": "This account has no password (signs in via SSO); there is nothing to change." }`. Returns `{ "success": true }`. Does not touch other sessions or API keys, the same as an admin resetting someone's password via `PUT /api/users/:id`.

---

## Printers

Printer management routes return `403` for the `uploader` role (see [auth.md](auth.md#roles)): `POST /api/printers`, `POST /api/printers/import`, `PUT /api/printers/:id`, `DELETE /api/printers/:id`, `POST /api/printers/:id/decommission`, `POST /api/printers/:id/complete-and-decommission`, `POST /api/printers/:id/recommission`, `POST /api/printers/test-connection`, `POST /api/printers/list-cameras`, plus `POST`/`DELETE /api/models`, `POST`/`DELETE /api/groups`, and `POST /api/backup/restore`:

```json
{ "error": "Uploaders cannot add, remove, or change printers or printer settings" }
```

### `GET /api/printers`

Returns all active printers (`is_active = 1`) in natural name order (`mini2` before `mini10`, case-insensitive; `server/natural-sort.js`). `GET /api/dashboard`'s `printers` uses the same order.

```json
[
  {
    "id": 1,
    "name": "MK4S_01",
    "ip": "192.168.1.100",
    "api_key": "aK3jR7xQ2pLm9vN",
    "group_name": "MK4S Farm",
    "type": "prusa",
    "model": "mk4s",
    "status": "PRINTING",
    "is_held": 1,
    "is_active": 1,
    "job_name": "4x Left Bracket_0.20n_MK4S_5h11m.bgcode",
    "job_progress": 45.2,
    "job_time_remaining": 10140,
    "created_at": 1774903214387
  }
]
```

`job_name`, `job_progress`, and `job_time_remaining` are non-null only while `status = "PRINTING"`, and are cleared to `null` when the printer leaves that state.

`last_parts_per_plate` is the `parts_per_plate` from the most recent finished (or currently printing) job — used by the Fleet UI to pre-fill the confirmed-qty input.

`has_active_job` is `1` if the printer currently has a job in `uploading` or `printing` status, `0` otherwise — used by the Fleet UI to show the OFFLINE-with-job confirmation buttons.

`uploading_job_name` is the filename of the printer's active `uploading` job (`null` when none). The Fleet UI uses it with `has_uploading_job` to display an "Uploading" status overlay while a file transfers — the hardware still reports IDLE during transfer, so this is presentation-only and never written back to `status`.

`needs_catalog` is `1` when the printer is `PRINTING` or `FINISHED` but no job row exists to own that activity, the signature of a print started outside the farm (sliced and sent straight to the printer, e.g. from OrcaSlicer, instead of through a Project/Part upload). The printer detail page opens the "catalog this print" popup automatically when this is `1`. See `POST /api/printers/:id/catalog-print` below and `docs/database.md`'s `jobs` section for exactly how it is computed.

`lanes` is every `printer_lanes` row for that printer (`[]` if none), e.g. `[{ "lane_index": 0, "material": "PLA", "color": "Black" }]`, synced from klipper-filament-sync (see `docs/database.md`'s `printer_lanes` section). The Fleet cards, Webcams page, and Dashboard/Webcams hover preview show it when present, falling back to `loaded_material`/`loaded_color` otherwise.

### `GET /api/printers/ams?model=<model_id>`

Returns the live AMS slot list from any connected Bambu printer of the given model. Used by the upload form to populate the slot picker.

Returns `[]` if no active Bambu printer of that model is connected or the model is not a Bambu type.

**Response** (example with one AMS and external spool):
```json
[
  { "slot": 0, "type": "PLA", "color": "FFFFFFFF" },
  { "slot": 1, "type": "PETG", "color": "000000FF" },
  { "slot": -1, "type": "PLA", "color": "FF6600FF" }
]
```

`slot` values: `0–N` = AMS tray (compound id: `ams_unit * 4 + tray_id`), `-1` = external spool.

---

### `GET /api/printers/:id`

Returns a single printer by ID. `404` if not found.

### `GET /api/printers/:id/camera`

Returns webcam feed info for a printer, if its connector supports one. `404` if the printer is not found.

**Response, camera available:**
```json
{
  "available": true,
  "streamUrl": "/api/printers/7/camera/stream",
  "snapshotUrl": "/api/printers/7/camera/snapshot",
  "rotation": 180,
  "flipH": true,
  "flipV": false
}
```

**Response, no camera (unsupported connector, none configured on the printer, or unreachable):**
```json
{ "available": false }
```

Currently implemented for `klipper` (via Moonraker's `/server/webcams/list`) and `octoprint` (via `/api/settings`'s `webcam` section). Other connectors always return `available: false`. `snapshotUrl` may be `null` even when `streamUrl` is present. For `klipper`, if the printer's `camera_uid` matches one of the webcams Moonraker reports, that one is used; otherwise the first enabled webcam is, same as before `camera_uid` existed.

`streamUrl`/`snapshotUrl` point at this server's own proxy routes below, not the printer's LAN address directly: see those two entries for why. `rotation`/`flipH`/`flipV` come straight from the printer row (`camera_rotation`/`camera_flip_h`/`camera_flip_v`), not from the connector: they are a display preference the client applies as a CSS transform, not something read from or written to the printer's own webcam server. Always present when `available: true`, regardless of connector.

### `GET /api/printers/:id/camera/snapshot`

Proxies one still image from the printer's webcam through this server, so the browser only ever needs to reach the manager, not the printer's own LAN address directly (the manager is already required to be on that LAN to poll the printer, so it can always reach the webcam even when the browser cannot). Streams the upstream response body through as-is, forwarding its `Content-Type` (normally `image/jpeg`).

`404` if the printer is not found, its connector has no camera support, or it currently reports no snapshot URL at all (same body shape as `GET /:id/camera`'s `available: false` case: `{ "error": "..." }`, message varies). `502` if the printer's webcam URL could not be reached (`{ "error": "Could not reach camera: <details>" }`). Aborts the upstream request if the client disconnects before it completes.

### `GET /api/printers/:id/camera/stream`

Same proxying, for the continuous MJPEG live stream instead of a single snapshot. Forwards `Content-Type` (normally `multipart/x-mixed-replace`) and pipes frames through until the client or the printer closes the connection; no fixed timeout once the upstream response has started. Same `404`/`502` semantics as the snapshot route above.

### `POST /api/printers/list-cameras`

Every webcam the connector currently reports for the given connection settings, for the camera picker on the Add Printer and printer-edit forms (a Klipper crowsnest setup can register more than one). Same shape and no-printer-required design as `test-connection` below, so it works before a printer is ever saved.

**Body:** same as `test-connection`'s: `{ "type": "klipper", "ip": "...", "api_key": "", "serial_number": "" }`. Required: `type`, `ip`.

**Response, always `200`:**
```json
{ "cameras": [
  { "uid": "abc123", "name": "Toolhead Cam", "enabled": true },
  { "uid": "def456", "name": "Bed Cam", "enabled": false }
] }
```

`400` only for a malformed request (missing `type`/`ip`, or an unregistered connector type). A connector without `listCameras` (everything but `klipper` today) always returns `{ "cameras": [] }`, not an error.

### `POST /api/printers/test-connection`

One-off reachability check against connection settings, without creating, saving, or looking up a printer by ID: the "Test Connection" button on the Add Printer and printer-edit forms. Implemented for every connector (unlike `GET /:id/camera` above, which only supports two).

**Body:**
```json
{ "type": "octoprint", "ip": "octoprint.local:5000", "api_key": "aK3jR7xQ2pLm9vN", "serial_number": "" }
```

Required: `type`, `ip`. `api_key` and `serial_number` default to `""` if omitted (fine for connector types that don't need them).

**Response, always `200`:**
```json
{ "ok": true, "message": "Connected" }
```
```json
{ "ok": false, "message": "Hostname did not resolve" }
```

`400` only for a malformed request: missing `type`/`ip`, or a `type` that is not a registered connector. A reachability failure is still a `200` with `ok: false`, the same way a driver's `getStatus` treats an unreachable printer as a normal outcome (`OFFLINE`) rather than an error. `message` on success notes when `ip` was a `.local` name and what it resolved to. Never touches a driver's cached persistent connection (Bambu, Centauri Carbon, Centauri Carbon 2): each connector's `testConnection()` opens and tears down its own one-off connection.

### `POST /api/printers`

Create a single printer.

**Body:**
```json
{
  "name": "MK4S_01",
  "ip": "192.168.1.100",
  "api_key": "aK3jR7xQ2pLm9vN",
  "model": "mk4s",
  "group_name": "MK4S Farm",
  "type": "prusa"
}
```

Required: `name`, `ip`, `api_key`, `model`. `ip` accepts a hostname, including a `.local` (mDNS) name, as well as a numeric address; see `docs/installation.md`'s credential table for the one remaining caveat (the original Elegoo Centauri Carbon's UDP discovery needing an IPv4 address). Optional: `group_name`, `type` (defaults to `"prusa"`), `auto_advance` (boolean, defaults to `false`), `camera_uid`, `camera_rotation` (`0`/`90`/`180`/`270`, defaults to `0`), `camera_flip_h`, `camera_flip_v` (booleans, default `false`), `octoeverywhere_url`.

`model` must be one of: `mk4`, `mk4s`, `c1`, `c1l`, `xl`.

`auto_advance` is for belt/conveyor printers: see the `auto_advance` note in `docs/database.md`'s printers table. Not importable via CSV; toggle it per printer through this endpoint or the printer detail page after creation.

`camera_uid`/`camera_rotation`/`camera_flip_h`/`camera_flip_v` are the display preferences `GET /:id/camera` returns; see `docs/database.md`'s printers table for what each one does.

`octoeverywhere_url` is an optional operator-supplied [OctoEverywhere](https://octoeverywhere.com) URL. When set, the "open web interface" links on Fleet and the Dashboard fleet grid use it instead of `http://<ip>`, for reaching the printer off the local network. Purely a link choice: unrelated to polling, dispatch, or connector behavior. See `docs/database.md`'s printers table.

Returns `201` with the created printer object. Returns `409` if `name` already exists.

### `PUT /api/printers/:id`

Partial update: only fields provided are changed (uses `COALESCE`, except `auto_advance`, `camera_uid`, `camera_rotation`, `camera_flip_h`, `camera_flip_v`, and `octoeverywhere_url`, which use the same "present in body wins" rule as `loaded_material`/`loaded_color` so an explicit falsy value, like unchecking a flip flag, clearing the selected camera, or clearing the OctoEverywhere URL, actually takes effect rather than a plain `COALESCE` silently keeping the old value). All fields from POST are accepted, plus `is_held` (`0` or `1`).

Returns `404` if not found, `409` on name conflict.

### `DELETE /api/printers/:id`

```json
{ "success": true }
```

Returns `404` if not found.

### `POST /api/printers/:id/set-ready`

Releases the printer's hold (`is_held = 0`) and immediately dispatches the next eligible job to it. Called by the Fleet UI when an operator confirms a print is good.

Accepts an optional body:
```json
{ "confirmed_qty": 24 }
```

If `confirmed_qty` is provided and differs from the `parts_per_plate` of the printer's most recent finished job, the delta is applied to the part's `completed_qty` (e.g. operator confirms 24 of 25 good → `completed_qty` decremented by 1). If the auto-credit had closed the part, it is reopened. Omitting the body leaves `completed_qty` unchanged.

**OFFLINE-with-job exception:** if the printer's current status is `OFFLINE` and it has a `printing` job (no finished job), qty is not credited and the job is not marked finished. The printer is simply unheld and the job continues to its natural finish. This is the "Job OK" path from the Fleet UI — the operator is confirming the job is still running, not that it completed.

Returns the updated printer object.

### `POST /api/printers/:id/catalog-print`

Attaches a print the farm never dispatched (sliced and sent straight to the printer, e.g. from OrcaSlicer) to a real Part, so it gets tracked like any other job. Only meaningful while `GET /api/printers` reports `needs_catalog: true` for this printer; the printer detail page's popup opens automatically in that case.

**Body:**
```json
{ "part_id": 12, "parts_per_plate": 5, "note": "optional" }
```

`part_id` and a positive `parts_per_plate` are required. `404` if the printer or part isn't found, `400` if `parts_per_plate` is missing or not positive, `409` if the printer isn't `PRINTING`/`FINISHED` or already has a tracked job (the double-submit guard, and the same condition `needs_catalog` itself checks).

Reuses the Part's existing gcode for this printer's model if one is already registered; otherwise records a placeholder gcode entry (there is no file to point at, since the farm never received one). Always logs a `note` event on the printer.

- **Printer is `FINISHED`:** credits `completed_qty` by `parts_per_plate` immediately, closes the Part/Project if targets are met (same cascade as `set-ready`'s missed-finish case), releases the hold, and dispatches the next job.
- **Printer is `PRINTING`:** creates the job as `printing` and stops there. `completed_qty` is credited later, exactly once, through the normal `_handleFinished` path when the poller sees the real `FINISHED` transition; nothing here is touched now.

Returns the updated printer object.

### `POST /api/printers/:id/decommission`

Removes the printer from active duty (`is_active = 0`). It will no longer be polled or receive jobs. Returns the updated printer object.

### `POST /api/printers/:id/complete-and-decommission`

Operator confirms the last print was successful, then takes the machine offline for maintenance instead of releasing it to the job queue.

- **Normal case** (job already in `finished` status): `_handleFinished` already credited `completed_qty`; nothing is re-credited. The printer is simply decommissioned.
- **Missed-finish case** (job still in `printing` status): credits `completed_qty` by `parts_per_plate`, marks the job `finished`, and closes the Part / Project if targets are met — same logic as `set-ready`, but ending in decommission rather than dispatch.

Returns the updated printer object.

### `POST /api/printers/:id/recommission`

Returns a decommissioned printer to active duty (`is_active = 1`, `is_held = 0`, clears `decommissioned_at`/`decommission_note`), logs a `recommission` event, and immediately dispatches the next eligible job via `scheduler.scheduleForPrinter`. Returns the updated printer object.

The dispatched job is marked `printing` before the next poll has updated the printer's stored status, so it briefly looks like an orphaned job on an `IDLE`/`FINISHED` printer. The scheduler's stale-job auto-fail only fires on jobs older than `STALE_JOB_GRACE_MS` (90s), so a freshly recommissioned-and-dispatched printer is not wrongly re-held if another dispatch (e.g. "Scan for Jobs") runs before the printer is re-polled as `PRINTING`.

### `POST /api/printers/:id/mark-job-failure`

Marks the printer's most relevant active or recently-completed job as `failed`, undoes the `completed_qty` increment if needed, reopens the Part and Project if needed, and decommissions the printer (`is_active = 0`).

**Job selection — two-query priority:**

1. **Active first:** finds the most recent `printing` or `uploading` job (`ORDER BY started_at DESC`). These jobs were never credited to `completed_qty`, so no undo is needed.
2. **Finished fallback:** if no active job exists, finds the most recent `finished` job — but only if no subsequent job was created for this printer after it finished. This scope guard prevents the endpoint from reaching back and decrementing `completed_qty` on an old job from a previous cycle when the printer is held for an unrelated reason.

**Per-status behaviour:**
- `finished` — `completed_qty` decremented by `parts_per_plate`. Part reopened if it was closed by this job; Project reopened if it was completed.
- `printing` — no qty change (was never credited).
- `uploading` — no qty change (print never started).

If no tracked job matches any of the above, the printer is still decommissioned — operator intent is always to take the machine offline.

Returns `{ "success": true, "job_id": N }` (or `job_id: null` when no job was found). Returns `404` only if the printer itself does not exist.

### `GET /api/printers/:id/linkable-jobs`

Returns jobs in `failed` or `uploading` status whose G-code was sliced for this printer's model. Used by the Fleet UI job-link picker. Returns up to 20 results, newest first.

Each job includes `part_name`, `gcode_filename`, `original_printer_name` (the printer it was originally dispatched to), and `original_printer_id`.

### `POST /api/printers/:id/link-job`

Manually associates a failed or stalled job with this printer — for record keeping when a job was dispatched but the upload appeared to fail while the printer actually started printing.

**Body:** `{ "job_id": N }`

Sets `jobs.status` to `'printing'`, updates `jobs.printer_id` to this printer, sets `jobs.started_at` if not already set, and releases the printer's hold (`is_held = 0`).

Returns `409` if the job is not in `failed` or `uploading` status. Returns `404` if the printer or job does not exist.

### `GET /api/printers/:id/events`

Returns all events for a printer, newest first.

```json
[
  {
    "id": 12,
    "printer_id": 57,
    "event_type": "job_failed",
    "note": "Job 304 — part: Left Bracket",
    "created_at": 1775001234567,
    "user_id": 3,
    "user_name": "Joel"
  }
]
```

Event types: `decommission`, `recommission`, `job_finished`, `job_failed`, `confirmed`, `info_changed`, `note`. `user_id`/`user_name` identify which signed-in user performed an operator-triggered event; both are `null` for a system-generated event (`job_finished` and friends, written by `scheduler.js` itself) or for any event written before this column existed. See `docs/database.md`'s `printer_events` section.

Returns `404` if the printer does not exist.

### `POST /api/printers/:id/events`

Adds a freeform operator note to the printer's event log, attributed to the signed-in user.

**Body:**
```json
{ "note": "Nozzle replaced, tension checked — cleared to run." }
```

Returns `201` with the created event object (including `user_id`/`user_name`). Returns `400` if `note` is missing or blank. Returns `404` if the printer does not exist.

### `GET /api/printers/:id/raw-status`

Proxies a live `GET /api/v1/status` call to the printer's PrusaLink API and returns the raw response. Used for debugging printer state from the Fleet UI (click any printer card to trigger this in the browser console).

```json
{
  "printer": { "id": 1, "name": "MK4S_35", "ip": "192.168.1.100" },
  "raw": { "printer": { "state": "IDLE", ... }, "storage": { ... } }
}
```

### `POST /api/printers/import`

Bulk import from CSV. `Content-Type: multipart/form-data`, field name `file`.

**CSV format** (header row required, column order flexible):

```
name,ip,api_key,group,type,model
MK4S_01,192.168.1.100,aK3jR7xQ2pLm9vN,MK4S Farm,prusa,MK4S
C1 Rarity,192.168.1.101,bR5mQ8nZ4vKs2Pw,CORE One Farm,prusa,C1
```

The `model` column is optional but strongly recommended. Valid values (case-insensitive): `MK4`, `MK4S`, `C1`, `C1L`, `XL`. When present it takes priority over name inference — any printer name is valid.

**Import rules:**
- If `model` column is present and valid, it is used directly (normalized to lowercase)
- If `model` column is absent or blank, model is inferred from `name` — see [database.md](database.md)
- If both fail, the row is **flagged** — not saved until operator resolves via the Settings UI or `POST /api/printers`
- Rows whose `name` already exists in the DB are **skipped** (not overwritten)
- Rows missing `name`, `ip`, or `api_key` are flagged

**Response:**
```json
{
  "imported": 2,
  "skipped": 1,
  "flagged": [
    {
      "row": { "name": "Twilight", "ip": "192.168.1.102", "api_key": "...", "group": "Core One Farm", "type": "prusa" },
      "reason": "Cannot infer model from name \"Twilight\". Please specify model manually."
    }
  ]
}
```

---

## Groups

Persisted registry of printer group names (see `printer_groups` in [database.md](database.md)). Independent of `printers.group_name`: a group stays registered even when no printer currently carries it, which is what lets a G-code's or project's `allowed_groups` restriction stay meaningful (and editable) after every printer in that group is reassigned elsewhere.

### `GET /api/groups`

Returns all registered groups, ordered by name.

```json
[{ "name": "Rack A", "created_at": 1783800000000 }]
```

### `POST /api/groups`

**Body:** `{ "name": "Rack A" }`. Required, trimmed. Returns `201` with the created row, or `409` if the name already exists.

Groups are also registered automatically: creating or updating a printer with a non-empty `group_name` not already in the registry adds it silently (see `POST /api/printers`, `PUT /api/printers/:id`, `POST /api/printers/import`).

### `DELETE /api/groups/:name`

Returns `404` if the group doesn't exist. Returns `409` if it's still referenced anywhere (an active printer's `group_name`, a G-code's `allowed_groups`, or a project's `allowed_groups`), with a message naming which:

```json
{ "error": "Cannot delete: group \"Rack A\" is used by 2 active printer(s), 1 G-code restriction(s)" }
```

---

## Projects

### `GET /api/projects`

Returns all projects ordered by `created_at DESC`.

### `GET /api/projects/:id`

Returns a single project. `404` if not found.

### `GET /api/projects/:id/eta`

Estimated completion of the project's whole remaining queue. `404` if the project doesn't exist.

```json
{ "remaining_seconds": 64014, "completion_at": 1790688000000, "incomplete": false, "eligible_printer_count": 2 }
```

Computed by a simulation of the whole farm (`server/project-eta.js` `simulateFarm`), replaying what the scheduler would do from now on, one plate at a time:

- **Printers:** every active printer. One printing now is free when its print ends (`printers.job_time_remaining`); an idle, unheld one is free now; one held for sign-off is free once an operator is on shift. OFFLINE, ERROR, and UNKNOWN printers take no work.
- **Queue:** open parts of active projects in the scheduler's order (priority override first, then `queue_order`), with the same model, group, and exact material/color eligibility (the optional color tolerance is not modeled) and the same work-conserving per-project plate cap (`max_concurrent_plates`, below). So another project's work ahead in the queue delays this one.
- **Plates:** each dispatch prints one whole plate of the G-code for that printer's model (`parts_per_plate` parts in `est_print_secs`); remaining plates come from `target_qty - completed_qty -` what is already printing.
- **Operators:** every print finishes held, so a printer that finishes only takes its next plate at the next moment an operator is on shift (`operator_hours_start` / `operator_hours_end` / `operator_days`, server local time; unset means always staffed). Printers with `auto_advance` do not wait.

Fields:
- `remaining_seconds`: until the project's last plate finishes printing. `0` when nothing is left; `null` when there is work left but none of it can be estimated.
- `completion_at`: that moment as epoch milliseconds, or `null`.
- `incomplete`: `true` when the estimate is a lower bound: a G-code without `est_print_secs`, a part no current printer can take, or the simulation's safety limit (20000 plates) reached.
- `eligible_printer_count`: active printers whose model matches one of this project's G-codes (informational).

The Dashboard's Active Projects panel includes the same numbers per project in `GET /api/dashboard` (`estimated_remaining_secs`, `estimated_completion_at`, `estimated_remaining_incomplete`), from one shared simulation per request.

### `POST /api/projects`

Required: `name`. Optional: `description`.

Returns `201` with created project (`status` defaults to `"draft"`).

Records the signed-in user as `created_by_user_id`/`created_by_name` on the new project (returned in the `201` body).

### `PUT /api/projects/:id/priority-override`

Operator/admin only (`403` for an uploader). Body `{ "enabled": true }` or `{ "enabled": false }` (`400` if not a boolean, `404` if the project does not exist). Sets `projects.priority_override`: the scheduler dispatches overridden work ahead of the normal queue order (either `queue_order`) and exempts it from the printer caps; see Dispatch order under Scheduler. Setting it triggers a sweep for idle printers. Returns the updated row. The general `PUT /api/projects/:id` never changes this flag.

```json
{ "enabled": true }
```

### `PUT /api/projects/:id`

Partial update. Accepts: `name`, `description`, `status` (`draft` | `active` | `paused` | `completed`), `max_concurrent_plates`.

When setting `status` to `active`, the UI also calls `POST /api/scheduler/dispatch` to trigger an immediate sweep of idle printers.

`max_concurrent_plates`: how many printers this project's own work may occupy at once while other eligible work is waiting (work-conserving: never leaves a printer idle just because of a cap). Present-in-body semantics: a positive integer (1-1000) sets it, `null` or `0` clears it back to unlimited, omitting the field entirely leaves it unchanged. `400` for anything else (a negative number, a non-integer). Set by whoever manages the project, not an admin Settings value: see [docs/database.md](database.md)'s `projects` table for why this replaced the earlier `max_printers_per_part`/`max_printers_per_project` settings, and the Scheduler section below for how it's enforced.

### `PUT /api/projects/:id/filament`

Sets project-wide default `required_material` / `required_color`, applied to every G-code in the project that doesn't set its own override.

**Body:** `{ "required_material": "PETG", "required_color": "Red" }`. Either field, empty string, or omitted resolves to `NULL` (no default).

### `PUT /api/projects/:id/groups`

Sets a project-wide default `allowed_groups`, applied to every G-code in the project that doesn't set its own `allowed_groups` override. Mirrors `PUT /api/gcodes/:id`'s `allowed_groups` field, and follows the same gcode-overrides-project precedence as `/filament` above; see the "Targeting cascade" note in [database.md](database.md).

**Body:** `{ "allowed_groups": ["Rack A", "Rack B"] }`. An empty array (or omitted) clears the project default back to unrestricted.

### `DELETE /api/projects/:id`

---

## Parts

### `GET /api/parts`

Optional query param `?project_id=N` to filter by project. Results ordered by `sort_order ASC, created_at ASC`.

Each part includes `active_qty` — the sum of `parts_per_plate` across all `uploading` or `printing` jobs for that part. Used by the progress bars in the Projects and Dashboard pages to show in-flight work.

### `GET /api/parts/:id`

Also includes `active_qty` (same calculation as the list endpoint).

### `GET /api/parts/:id/dispatch-status`

Diagnostic for the "Why isn't this printing?" button on the Projects page. Mirrors the scheduler's eligibility rules and returns why the part is or isn't dispatching right now.

```json
{
  "dispatchable": false,
  "reasons": ["gridfinity_2x4_x1c.3mf: all 1 matching printer(s) are busy"],
  "notes": []
}
```

- `reasons`: populated when `dispatchable` is `false`: global blockers (project not active, part complete, no G-code, remaining qty already covered by in-progress jobs) followed by per-G-code availability problems (pending print approval, no printers of that model, group/material/color mismatch, all matching printers busy or held).
- `notes` — populated when `dispatchable` is `true`: advisory per-G-code items (e.g. one G-code can dispatch but another has no ready printers).

The material/color check counts a printer as a match via its own `loaded_material`/`loaded_color`, or via any single one of its `printer_lanes` rows (a multi-lane Klipper printer synced from the klipper-filament-sync plugin): mirrors `server/scheduler.js`'s candidate query exactly, see `docs/database.md`'s `printer_lanes` entry.

If no printer has the exact required color and the `color_tolerance` setting is above `0`, a printer with a close enough color (by hex-code RGB distance, `server/color-distance.js`) counts as a match too, same as the scheduler's own fallback. When that's what makes a G-code dispatchable, `notes` includes a line naming it (`"... matched via color tolerance, not an exact color ..."`) so the operator understands why the color shown doesn't exactly match what was requested. Material is never loosened by this setting.

### `POST /api/parts`

Required: `project_id`, `name`, `target_qty`.

A new part always starts `open` with `completed_qty: 0`. If the parent project's status is `completed`, it's reactivated to `active` immediately (same as `POST /api/projects/:id/reactivate`) without a separate manual reactivate step. A scheduler sweep also runs at this point, but it can't dispatch the new part itself yet: the scheduler's candidate query requires a matching G-code, and a brand-new part has none. The part becomes an actual dispatch candidate once G-code is uploaded for it (see `POST /api/gcodes/upload`, which triggers its own sweep).

Records the signed-in user as `created_by_user_id`/`created_by_name` on the new part (returned in the `201` body and on `GET /api/parts`).

### `PUT /api/parts/:id/priority-override`

Operator/admin only (`403` for an uploader). Body `{ "enabled": true }` or `{ "enabled": false }` (`400` if not a boolean, `404` if the part does not exist). Sets `parts.priority_override`: the scheduler dispatches overridden work ahead of the normal queue order (either `queue_order`) and exempts it from the printer caps; see Dispatch order under Scheduler. Setting it triggers a sweep for idle printers. Returns the updated row. The general `PUT /api/parts/:id` never changes this flag.

```json
{ "enabled": true }
```

### `PUT /api/parts/:id`

Partial update. Accepts: `name`, `target_qty`, `completed_qty`, `status`.

**`completed_qty` auto-status:** when `completed_qty` is included in the request body, `status` is recalculated server-side — `closed` if `completed_qty >= target_qty`, `open` otherwise. An explicit `status` field in the body is ignored when `completed_qty` is also present.

**Reactivation:** if this update flips the part from `closed` back to `open` (e.g. raising `target_qty` above `completed_qty`) and the parent project's status is `completed`, the project is reactivated to `active` and the scheduler sweeps for idle printers immediately, same behavior as `POST /api/parts` and `POST /api/projects/:id/reactivate`.

### `PUT /api/parts/reorder`

Sets `sort_order` for a list of parts in one transaction. Send the full ordered array of IDs — index position becomes the new `sort_order`.

**Body:**
```json
{ "ids": [3, 1, 2] }
```

**Response:** `{ "success": true }`

Returns `400` if `ids` is missing or empty.

### `DELETE /api/parts/:id`

Safe cascade delete. Runs entirely in a single transaction.

Returns `409` if any job for this part is currently `uploading` or `printing` — deletion is blocked while dispatch is active. Wait for the job to finish or cancel it first.

On success:
- All jobs for the part are deleted (history has no meaning without the part).
- All G-code records for the part are deleted and their physical files removed from `server/gcode/`.
- The part itself is deleted.

```json
{ "success": true }
```

Returns `404` if not found.

---

## G-codes

### `GET /api/gcodes`

Optional query param `?part_id=N` to filter by part.

Returns all G-code records. Each record includes `part_id`, `printer_model`, `filename`, `filepath`, `parts_per_plate`, `est_print_secs`, `material_grams`, `ams_slot`, `allowed_groups`, `required_material`, `required_color`, `created_at`.

`filepath` stores only the filename (not an absolute path) — the server resolves the full path at runtime using its own `server/gcode/` directory. This makes the DB portable across machines.

### `POST /api/gcodes/parse-filename`

Parses a G-code filename and returns structured fields without saving anything. Used to pre-fill the upload form and per-gcode estimate inputs.

**Body:** `{ "filename": "4x Left Bracket_0.20n_0.40mm_MK4S_MK4S_5h11m.bgcode" }`

**Response (success):**
```json
{
  "parse_failed": false,
  "parts_per_plate": 4,
  "printer_model": "mk4s",
  "est_print_secs": 18660,
  "material_grams": null,
  "part_name_hint": "Left Bracket"
}
```

**Response (no match):** `{ "parse_failed": true, "material_grams": null }`

`material_grams` is extracted from flexible patterns anywhere in the filename (e.g. `45g`, `1.2kg`) and is returned regardless of whether the strict Bambu-format parse succeeded. Either field may be `null` if not found.

### `POST /api/gcodes/upload`

Upload a G-code file and create a DB record. `Content-Type: multipart/form-data`, file field name `file`.

**Form fields:**
- `part_id` (required)
- `parts_per_plate` (required)
- `printer_model` (required) — must be a registered model ID
- `est_print_secs` (optional): per-plate print time in seconds. Used only when the file's own header has no print time (see below)
- `material_grams` (optional): per-plate material weight in grams. Used only when the file's own header has no filament weight
- `ams_slot` (optional) — Bambu only
- `allowed_groups` (optional): JSON array string e.g. `'["Rack A","Rack B"]'`; restricts dispatch to printers in one of these groups. Omitted or empty means unrestricted at the G-code level (falls back to the project's `allowed_groups`, if any; see `PUT /api/projects/:id/groups`)
- `required_material` / `required_color` (optional): overrides the project's defaults for this G-code specifically

Returns `201` with created G-code record. Returns `409` if a G-code for this `(part_id, printer_model)` combination already exists.

A part only becomes a real dispatch candidate once it has at least one matching, *approved* G-code (the scheduler's candidate query joins on `gcodes` and checks `approved = 1`). The created record's `approved` field is `0`, not the usual `1`, if the uploading account (`req.user`) has `requires_print_approval` set; see [docs/auth.md](auth.md)'s Print approval section and `POST /api/gcodes/:id/approve` below. A successful upload triggers a scheduler sweep immediately regardless, so an idle printer can pick up the part right away instead of waiting for a manual dispatch or the next printer status transition; an unapproved G-code just won't be a candidate that sweep finds anything for yet.

Records the uploading user as `uploaded_by_user_id`/`uploaded_by_name` on the new G-code (returned in the `201` body and on `GET /api/gcodes`).

**Print stats from the file header:** `est_print_secs`, `material_grams`, and `material_type` are read from the uploaded file's own slicer metadata (`server/gcode-metadata.js` `readPrintStats`) and take precedence over the form fields above, which stay as the fallback for a file that does not say. Supported: PrusaSlicer (`.gcode` and `.bgcode`: `estimated printing time (normal mode)`, `total filament used [g]` or the summed `filament used [g]`, `filament_type`), OrcaSlicer (same keys, or with a Bambu profile `total estimated time:` and `total filament weight [g] :`; also inside a sliced `.3mf`), and ideaMaker (`;Print Time:` seconds, grams computed from `;Material#N Used:` length, `;Filament Diameter #N:` and `;Filament Density #N:`, and `;Filament Type #N:`). Rules follow Moonraker's metadata parser and the slicers' own writer code. `material_type` is display only: it is never copied into `required_material`. The slicer upload endpoint records the same three fields.

### `PUT /api/gcodes/:id`

Update `est_print_secs`, `material_grams`, `allowed_groups`, `required_material`, and/or `required_color` for a G-code. Omitting a field leaves it unchanged; sending `null` (or, for the time/material fields, `""`) clears it back to "inherit from project / unrestricted".

**Body:**
```json
{ "print_time": "2h15m", "material_grams": "45g", "allowed_groups": "[\"Rack A\"]", "required_material": "PETG", "required_color": "Red" }
```

`print_time` accepts the same human-readable formats as `PUT /api/parts/:id` did for `print_time`: `"2h15m"`, `"90m"`, `"1:30:00"`, bare integer (seconds). Returns `400` if non-empty and unparseable.

`material_grams` accepts `"45g"`, `"45.5g"`, `"1.2kg"`, bare number. Returns `400` if non-empty and unparseable.

`allowed_groups` is a JSON-encoded array string, matching the shape `POST /api/gcodes/upload` accepts (see above). This G-code's `allowed_groups`, `required_material`, and `required_color` always take precedence over the project's defaults when set; see `PUT /api/projects/:id/groups` and `PUT /api/projects/:id/filament`.

Returns the updated G-code record.

### `GET /api/gcodes/:id/thumbnail`

Returns the plate thumbnail embedded in the sliced file, if the format has one and one was found: `image/png` or `image/jpeg` bytes, extracted on demand from the file on disk (nothing is precomputed or stored). Response carries `Cache-Control: private, max-age=31536000, immutable`, since a gcode file's thumbnail can never change after upload.

Supported formats:
- `.bgcode` (Prusa): reads the binary block structure per the [official spec](https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md), picking the largest embedded thumbnail block. Heatshrink-compressed thumbnail blocks are skipped (no Node decoder available); Deflate and uncompressed blocks are supported.
- `.3mf` (Bambu Studio / OrcaSlicer): reads the ZIP container looking for `Metadata/plate_1.png`, falling back to any `Metadata/plate_<N>.png`, then `Metadata/bbl_thumbnail.png`.
- Plain `.gcode` never has an embedded thumbnail and is not parsed.

Returns `404` if the G-code record does not exist, the file is missing from disk, or no thumbnail could be found or extracted (corrupt file, unsupported compression, unrecognized format).

### `DELETE /api/gcodes/:id`

Deletes the DB record and removes the file from disk. Returns `{ "success": true }`.

### `POST /api/quick-print`

Upload one sliced file and print it once, without building a project. `Content-Type: multipart/form-data`, file field `file` (`.gcode`, `.gco`, `.g`, `.bgcode`, `.3mf`). Available to every role unless the user's group turns off `can_quick_print` (`403`).

**Form fields:**
- `printer_id` (optional, **operator/admin only**): pins the print to that exact printer through `gcodes.target_printer_id`. `403` for any other role.
- `printer_model` (optional, every role): narrows to a printer type ("any Mini") without pinning to one machine, still shares fairly across every printer of that model. Ignored if `printer_id` is set.
- `priority` (optional boolean, **operator/admin only**): sets `parts.priority_override`, jumping this print ahead of the normal queue order, the same as `PUT /api/parts/:id/priority-override`. `403` for any other role.
- `parts_per_plate` (optional, default 1).

Picking one exact machine or the front of the queue can starve other users' work on shared hardware, so both require operator or admin; a plain uploader can only leave the printer unset or narrow it to a type. It goes through the same path as the slicer endpoint: one part (target quantity equals the plate) in the caller's own "Uploads: <name>" project, one G-code, dispatched by the scheduler. Nothing here changes `parts.completed_qty` outside the normal Set Ready flow. The printer model comes from the chosen printer, else the chosen type, else the file header, else the only active model on the farm.

```json
{ "project_id": 12, "part_id": 40, "gcode_id": 41, "filename": "bracket.gcode", "printer_model": "mk4s", "target_printer_id": 3, "priority": false, "pending_approval": false }
```

Returns `201`. `400` for an unknown or ambiguous model, a bad `parts_per_plate`, no active printer of a requested `printer_model`, or a file sliced for a different model than the chosen printer or type, `403` for a printer or plate count the user's group does not allow, for `printer_id`/`priority` from a non-operator, or `printer_model` the user's group does not allow, `404` for an unknown printer, `409` for a decommissioned printer, `415` for an unsupported file type. `pending_approval` is true when the user's group or account requires approval; the print then waits for `POST /api/gcodes/:id/approve`.

### `POST /api/gcodes/:id/approve`

Admin or operator. Sets `approved = 1` on a G-code uploaded by an account with `requires_print_approval` set, making it a dispatch candidate. `404` if not found. Idempotent: approving an already-approved G-code is a `200` no-op, not an error. Triggers a scheduler sweep, same reasoning as `POST /api/gcodes/upload`: the part this G-code belongs to may now have an idle printer waiting for it.

Returns `409` if the gcode is referenced by an active job (`queued`, `uploading`, or `printing`). Wait for the job to finish or cancel it before deleting.

Historical jobs (`finished`, `failed`, `cancelled`) are retained with their `gcode_id` nulled out so job history is preserved.

---

## Jobs

### `GET /api/jobs`

Returns jobs with part/project/printer names joined. Supports query params: `?printer_id=N`, `?part_id=N`, `?project_id=N`, `?status=printing`.

Each job includes: `part_name`, `project_id`, `project_name`, `printer_name`, `printer_model`, `printer_is_held`, `printer_status`, `part_owner_user_id`, `part_owner_name`, `gcode_uploaded_by_user_id`, `gcode_uploaded_by_name`.

The owner fields are joined from the job's part (`parts.created_by_*`) and G-code (`gcodes.uploaded_by_*`); any of them is `null` for rows created before user tracking, and the uploader fields are `null` if the job's G-code row no longer exists.

```json
{
  "id": 42,
  "status": "printing",
  "part_name": "Clip",
  "project_name": "Brackets",
  "part_owner_user_id": 3,
  "part_owner_name": "Alice",
  "gcode_uploaded_by_user_id": 5,
  "gcode_uploaded_by_name": "Bob"
}
```

Job statuses: `uploading` | `printing` | `queued` | `finished` | `failed` | `cancelled`.

`printer_is_held` and `printer_status` are the current state of the job's printer, not a property of the job row itself. A job can sit at `status: "printing"` after its printer has already been held for operator sign-off (for example a printer that goes `PRINTING` -> `IDLE` directly, with no observable `FINISHED`/`STOPPED` in between polls): the job stays `printing` until Set Ready or Bad Print resolves it. Clients should treat `status === 'printing' && printer_is_held === 1 && printer_status !== 'PRINTING'` as "awaiting operator confirmation," not as an active print.

### `GET /api/jobs/:id`

Single job with same joins, including `printer_is_held` and `printer_status`. `404` if not found.

### `DELETE /api/jobs/:id`

Cancels a job. Returns `409` if status is not `queued` (only queued jobs can be cancelled).

---

## Slicer upload (OctoPrint and Moonraker compatible)

`server/routes/slicer-upload.js`. One base URL per printer group, outside `/api`:

```
http://<farm-host>:3000/slicer/<group name, URL-encoded>
```

PrusaSlicer and OrcaSlicer upload to it as a physical printer: host type **OctoPrint** (PrusaSlicer) or **Octo/Klipper** or **Moonraker** (OrcaSlicer), with the base URL as the hostname and a farm API key (Account > API Keys) as the API key. Implemented from the slicers' own client code (PrusaSlicer 2.9.0 `src/slic3r/Utils/OctoPrint.cpp`, OrcaSlicer `src/slic3r/Utils/OctoPrint.cpp` and `Moonraker.cpp`), not yet validated with a real slicer.

**Auth:** `X-Api-Key: <farm API key>` (what both slicers send) or `Authorization: Bearer <key>`. `401` with no or an invalid key, `403` for an account pending approval. **Group:** must exist in `printer_groups`, else `404`.

| Method and path (under the base URL) | Emulates | Response |
|---|---|---|
| `GET /api/version` | OctoPrint connection test | `{ "api": "0.1", "server": "1.10.0", "text": "OctoPrint 1.10.0 (Print Farm Manager)" }` (PrusaSlicer requires `api` and a `text` starting with `OctoPrint`) |
| `GET /api/server` | OctoPrint | `{ "version": "1.10.0", "safemode": null }` |
| `POST /api/files/local` | OctoPrint upload | multipart `file` (required), `print`, `path`, `select` (accepted, see below). `201`, OctoPrint's upload response shape |
| `GET /server/info` | Moonraker connection test | `{ "result": { "klippy_state": "ready", ... } }` |
| `GET /server/files/roots` | Moonraker | `{ "result": [{ "name": "gcodes", "path": "/gcodes", "permissions": "rw" }] }` |
| `POST /server/files/upload` | Moonraker upload | multipart `file`, `root`, `plateindex` (accepted). `201`, `{ "result": { "item": { "path": "<name>", "root": "gcodes" }, "print_started": false, "print_queued": true, ... } }` |
| `POST /printer/print/start` | Moonraker start | `{ "result": "ok" }`: a no-op, the upload already queued the print |

**What an upload does:** it never goes straight to a printer. In one transaction it creates (on first use) the uploader's own active project `Uploads: <user name>`, a Part named after the file (one plate: `target_qty` = parts per plate, read from a `4x Name` filename prefix, else 1), and a G-code restricted to this group (`allowed_groups = ["<group>"]`), attributed to the uploader, `approved = 0` if the account has `requires_print_approval`. Then it sweeps for idle printers. "Upload" and "Upload and print" behave the same: the scheduler decides when it runs (queue order, caps). A `completed` uploads project is reopened, like `POST /api/parts`.

**Printer model:** read from the file's own `printer_model` metadata (`server/gcode-metadata.js`: `.gcode` comment lines, `.bgcode` metadata blocks, or a sliced `.3mf`'s plate G-code) and matched to `printer_models` by normalized id or label ("MK4S" = `mk4s`, "COREONE" = "Core One", "Bambu Lab X1 Carbon" contains "X1 Carbon"). If the file has none, the group's model is used when every active printer in the group is the same model.

**Errors:** `400` if the model cannot be determined in a mixed group, if the file was sliced for a model the group has no printers of, or if the group has no active printers and the file names no model; `415` for anything but `.gcode`/`.gco`/`.g`/`.bgcode`/`.3mf`. A rejected upload leaves no file or row behind. The stored filename is reduced to a safe basename.

```json
{
  "files": { "local": { "name": "4x Bracket.gcode", "path": "4x Bracket.gcode", "origin": "local", "refs": { "resource": "http://farm:3000/slicer/Rack%20A/api/files/local/4x%20Bracket.gcode" } } },
  "done": true,
  "effectiveSelect": false,
  "effectivePrint": false,
  "farm_gcode_id": 42
}
```

---

## Scheduler

### `POST /api/scheduler/dispatch`

Triggers an immediate dispatch sweep — queries all currently idle, non-held printers and attempts to dispatch the next eligible job to each. No request body required.

```json
{ "ok": true }
```

Called by the Projects UI when a project is activated or resumed.

### Dispatch order

When a printer is free, the scheduler (`server/scheduler.js` `_reserveCandidate`) walks the eligible parts (open part, active project, approved G-code for this printer's model, group/material/color match) in queue order and takes the first one that still needs prints. Work with a priority override (`parts.priority_override` or its project's, set by an operator or admin) always comes first and is not limited by the caps below; within each group:

- `queue_order = "priority"` (default): `projects.priority`, then `projects.created_at`, then `parts.sort_order`, then `parts.created_at`. This is the drag order on the Projects page.
- `queue_order = "fifo"`: `gcodes.created_at` of the part's G-code for this printer's model, oldest first. A duplicated project's G-codes count from when they were duplicated.

With a project's own `max_concurrent_plates` set (see the Projects section above), a candidate whose project already has that many jobs `uploading`/`printing` is skipped in favor of the next eligible one, before any job row (dispatch lock) is written. Only if every eligible candidate is capped does the scheduler take a capped one anyway, so a cap never idles a printer. `GET /api/parts/:id/dispatch-status` adds a note (not a blocker) when a part's project is at its cap.

---

## Notifications

In-memory store of server-side alerts that require operator attention. Lost on server restart (errors will recur naturally on the next dispatch attempt if unresolved).

### `GET /api/notifications`

Returns all current notifications, newest first.

```json
[
  {
    "id": 1,
    "message": "G-code file missing for \"4x Left Bracket_MK4S_5h11m.bgcode\" — re-upload the file for part \"Left Bracket\" in project \"Batch 7\". Printer MK4S_03 has been held.",
    "timestamp": 1774903214349
  }
]
```

### `DELETE /api/notifications/:id`

Dismisses a notification. Returns `{ "ok": true }`. Returns `404` if not found.

---

## Settings

### `GET /api/settings`

Returns all operator settings as a flat object, e.g. `{ "dispatch_batch_size": "10", "farm_name": "My Farm" }`.

### `PUT /api/settings/:key`

Body: `{ "value": "..." }`. Allowed keys:

| Key | Validation | Used by |
|---|---|---|
| `dispatch_batch_size` | integer 1-100 | How many printers the scheduler keeps uploading or printing at once (a concurrency target, not a fixed group size; it draws deeper into the ready queue to fill the target if some printers have no dispatchable candidate) |
| `farm_name` | ≤ 40 chars | Sidebar branding (falls back to "Print Farm") |
| `auto_sso_redirect` | `"0"` or `"1"` | Admin-only (`403` for a non-admin, even with a valid session). Whether the login page skips the local form and redirects straight to the OIDC provider; see [docs/auth.md](auth.md). |
| `color_tolerance` | integer 0-450 | Any authenticated user. RGB-distance (server/color-distance.js) fallback the scheduler and `GET /api/parts/:id/dispatch-status` use when no printer has the exact required color loaded; `0` (the default) disables it. See `docs/database.md`'s `printers` section and the scheduler note below. |
| `upload_retry_window_min` | integer 1-180 | How many minutes the scheduler keeps retrying a failing upload on later sweeps (roughly every 15s, tied to the poller's cycle) before finally holding the printer for operator confirmation. Default `15`. See `jobs.upload_first_failed_at` in [docs/database.md](database.md). |
| `require_uploader_approval` | `"0"` or `"1"` | Admin-only. Off by default. Whether a new `uploader` account auto-provisioned via OIDC must be approved (`POST /api/users/:id/approve`) before it can sign in; see [docs/auth.md](auth.md)'s Account approval section. |
| `update_repo` | must look like `owner/repo` | Admin-only. GitHub repo the Software Update section (Settings page) checks the running build against, e.g. `maevebaksa/print-farm-manager`. See the Update section below and [docs/deployment.md](deployment.md). |
| `queue_order` | `"priority"` or `"fifo"` | Admin-only. Which waiting print a free printer takes next. `priority` (the default when unset): project priority, then part `sort_order`. `fifo`: first in, first out by the matching G-code's upload time (`gcodes.created_at`); project and part order are ignored. See the Scheduler section below. |
| `operator_hours_start` / `operator_hours_end` | `HH:MM` (24-hour) or `"off"` | Admin-only. The operator shift used by the completion estimates (`GET /api/projects/:id/eta`): a printer that finishes outside it waits for the next shift. An end before the start is an overnight shift. Either one `"off"` (or unset) means always staffed. Server local time. |
| `operator_days` | comma-separated `0`-`6` (0 = Sunday) | Admin-only. Days the shift runs; default every day. |

Returns `400` for unknown keys or failed validation, `403` if a non-admin sends `auto_sso_redirect`, `require_uploader_approval`, `update_repo`, `queue_order`, `operator_hours_start`, `operator_hours_end`, or `operator_days`.

How many printers one project's own work may occupy at once is not a Settings key: it is `max_concurrent_plates` on the project itself (`PUT /api/projects/:id`, any role that can edit projects), replacing an earlier admin-only `max_printers_per_part`/`max_printers_per_project` pair of settings. See the Projects section above and [docs/database.md](database.md).

---

## Dashboard

### `GET /api/dashboard`

Single endpoint that returns all data required by the TV dashboard in one call. Polled every 15 seconds by the Dashboard page.

```json
{
  "stats": {
    "printing": 38,
    "idle": 8,
    "awaiting": 6,
    "parts_today": 847
  },
  "printers": [ ... ],
  "active_projects": [
    {
      "id": 1,
      "name": "Spring Product Line",
      "status": "active",
      "parts": [
        { "id": 3, "name": "Left Bracket", "completed_qty": 671, "target_qty": 1000, "status": "open", ... }
      ]
    }
  ],
  "recent_activity": [
    {
      "id": 512,
      "status": "finished",
      "parts_per_plate": 25,
      "finished_at": 1774903214349,
      "part_name": "Left Bracket",
      "printer_name": "MK4_07"
    }
  ]
}
```

**`stats` fields:**
- `printing` — printers currently in `PRINTING` status
- `idle` — printers in `IDLE` status with no hold
- `awaiting` — printers held (`is_held = 1`) in `FINISHED` or `IDLE` state, waiting for operator sign-off
- `parts_today` — sum of `parts_per_plate` on `finished` jobs in the rolling 24-hour window (`finished_at >= now - 86400000`)

`printers` is the same shape as `GET /api/printers` (includes `last_parts_per_plate`) plus `last_event_at` — the timestamp of the most recent `printer_events` row for that printer.

`active_projects` includes only `status = 'active'` projects, ordered by `priority ASC, created_at ASC` (same order as `GET /api/projects` and the scheduler's dispatch query, so the dashboard's project order matches what actually dispatches next), each with a nested `parts` array ordered by `sort_order`, plus three computed stats fields:

- `elapsed_secs` — total wall-clock print time in seconds: sum of `finished_at − started_at` for all `finished` jobs in the project, plus `now − started_at` for any currently `printing` job.
- `material_used_grams` — total material consumed in grams: sum of `gcode.material_grams / gcode.parts_per_plate * job.parts_per_plate` across all `finished` jobs that have a linked gcode with `material_grams` set. `null` if no jobs have gcode material data.
- `model_breakdown` — array of per-printer-model summaries for all finished jobs: `{ printer_model, jobs_count, parts_printed, material_grams, elapsed_secs }`, ordered by `parts_printed DESC`.
- `estimated_remaining_secs` / `estimated_completion_at` / `estimated_remaining_incomplete`: the same farm-simulation estimate as `GET /api/projects/:id/eta` above (see that entry), from one `simulateFarm` run shared by every project in the response.

`recent_activity` is the 12 most recent `finished` or `failed` jobs, each with `part_name` and `printer_name` joined in. (Retained in the payload for compatibility; the dashboard UI no longer renders this list — see [web-app.md](web-app.md).)

---

## Update

Admin-only. Backs the Software Update section of the Settings page; see [docs/deployment.md](deployment.md) for the full mechanism and the security tradeoff of enabling the trigger.

### `GET /api/update/status`

```json
{
  "repo": "maevebaksa/print-farm-manager",
  "currentCommit": "a1b2c3d4e5f6...",
  "latestCommit": "f6e5d4c3b2a1...",
  "updateAvailable": true,
  "canTrigger": false
}
```

`currentCommit` comes from the `GIT_COMMIT` environment variable baked into the image at build time (`unknown` for a locally-built image without that build-arg). `latestCommit` is the latest commit on the `update_repo` setting's `main` branch, fetched unauthenticated from the GitHub API; `null` if `update_repo` is not set, the repo is private or nonexistent, or the request fails for any reason. `updateAvailable` is `true` only when both commits are known and differ. `canTrigger` reflects whether the Docker socket and compose project directory are bind-mounted (see below), independent of whether an update is actually available.

### `POST /api/update/trigger`

No body. Runs `docker compose pull && docker compose up -d` against the bind-mounted compose project directory and responds immediately, before the update is known to have succeeded, since the container issuing the request is usually replaced by it. Output is appended to `server/data/update.log`.

`409` with `{ "error": "..." }` if `canTrigger` is false: the operator has not bind-mounted both `/var/run/docker.sock` and the compose project directory (see `docker-compose.yml`'s commented-out example), so there is nothing this route can do.

---

## Error Responses

All error responses use this shape:

```json
{ "error": "Human-readable message" }
```

| Status | Meaning |
|---|---|
| `400` | Missing required field or invalid value |
| `404` | Resource not found |
| `409` | Conflict (e.g. duplicate printer name) |

---

## Backup

### `GET /api/backup`

Downloads a full farm snapshot as `farm-backup-YYYY-MM-DD.json`. Includes `printers`, `printer_lanes`, `projects`, `parts`, `gcodes`, `jobs`, `printer_events`, `printer_models`, `printer_groups`, `filament_types`, `filament_colors`, `filament_color_types`, `settings`, and gcode file contents (base64 encoded, keyed by on-disk filename). No request body.

**Response:** `Content-Disposition: attachment` JSON file.

### `POST /api/backup/restore`

`403` for the `uploader` role (a restore replaces the printer table; see Printers above).

Replaces all farm data from a previously exported backup file. Clears the DB and rewrites all tables; gcode files are written to `server/gcode/`. Since `filepath` stores only the filename, no path rewriting is needed — the restored DB works correctly on any machine. Each `gcode_files` key must be a bare filename — any key that isn't (e.g. containing `/`, `\`, or equal to `.`/`..`) is rejected with `400` before anything is written to disk, since it would otherwise be able to resolve outside `server/gcode/`.

Each table's restore INSERT covers the columns the *live* schema currently has (derived from `PRAGMA table_info`) that are also present in the backup's data, rather than a hardcoded list: so printer `serial_number`/`loaded_material`/`loaded_color`, project `required_material`/`required_color`/`allowed_groups`, part `print_time_seconds`/`material_grams`, and gcode `ams_slot`/`material_grams`/`allowed_groups`/`required_material`/`required_color` all round-trip correctly, along with any future column a migration adds. A column present in the live schema but missing from every row of a given backup (e.g. an older backup that predates it) is omitted from the INSERT entirely so the column's own schema default applies, instead of failing on `NOT NULL` columns like `parts.sort_order`.

`printer_models`, `printer_groups`, `filament_types`, `filament_colors`, and `settings` are restored the same way, but each is only cleared and rewritten if that key is present in the uploaded file: restoring a backup taken before these were added to the export leaves the farm's current printer models, groups, filament library, and settings untouched rather than wiping them with nothing to restore.

**Request:** `multipart/form-data` with field `file` — the `.json` backup file. Max 500 MB.

```json
{
  "ok": true,
  "printers": 52,
  "printer_lanes": 8,
  "projects": 3,
  "parts": 12,
  "gcodes": 18,
  "jobs": 340,
  "printer_events": 210,
  "printer_models": 6,
  "printer_groups": 4,
  "filament_types": 3,
  "filament_colors": 9
}
```
| `500` | Unhandled server error |
