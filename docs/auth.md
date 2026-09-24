# Authentication

Every route under `/api/*` except the ones listed below requires a signed-in user or a valid API key. There is no anonymous access to farm data or controls once at least one account exists.

## Two ways to authenticate

1. **Session cookie**: the browser client. `POST /api/auth/login` (or the bootstrap/OIDC flows below) sets an httpOnly `pfm_session` cookie; every subsequent request includes it automatically.
2. **API key**: for scripts, OrcaSlicer, or any tool calling the REST API directly. Send `Authorization: Bearer <key>`. A key acts as its owning user for every request: full access, not scoped to specific routes. Generated and revoked from Account → API Keys in the app; the plaintext is shown exactly once, at creation.

Both resolve to the same `req.user` shape server-side (`{ id, email, name, role, oidc_subject, created_at, last_login_at }`): route handlers never need to know which one was used, except where noted.

## Public routes (no auth required)

- `GET /api/health`
- `GET /api/auth/status`, `POST /api/auth/bootstrap`, `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/auth/oidc/login`, `GET /api/auth/oidc/callback`

Everything else, including `GET /api/auth/me`, requires authentication.

## Roles

Three roles: `admin`, `operator`, and `uploader`.

- `admin` and `operator` have full access to every farm-operation route (printers, projects, jobs, dispatch). Only `admin` can reach `/api/users/*` (creating, editing, or removing accounts). The app refuses to demote or delete the last remaining admin, so the farm can never lock itself out of account management.
- `uploader` has the same access as `operator` except it cannot release a held printer back into the dispatch queue: `POST /api/printers/:id/set-ready` and `POST /api/printers/set-ready-batch` (the Fleet page's "Set Ready" / "Set Ready (N)" actions) both 403 for it (`server/auth.js`'s `blockRole('uploader')`, applied in `server/index.js`). Confirming a printer's physical print outcome is an operator judgment call; an uploader account (for a script or a person who only queues work, e.g. via `POST /api/gcodes/upload` or an API key) is not expected to make it. Everything else an uploader does (uploading G-code, managing projects/parts, viewing the fleet, marking a print failed via Bad Print) is unrestricted, unless that specific account has `requires_print_approval` set: see Print approval below.
- `uploader` is the default role: `POST /api/users` with no `role` in the body creates one, and a brand new account auto-provisioned via OIDC login (see below) is also `uploader`, on the principle that a new account should start at the least-privileged role an admin then explicitly promotes, rather than defaulting to full operator access.

`server/routes/users.js`'s `VALID_ROLES` is the single source of truth for the set of accepted role strings; both `POST /api/users` and `PUT /api/users/:id` validate against it (`400` for anything else).

## Account approval

Admin-only setting `require_uploader_approval` (Settings page → Account Approval, `PUT /api/settings/require_uploader_approval`, `"0"`/`"1"`, off by default). When on, a brand new `uploader` account that appears on its own via OIDC auto-provisioning (see below) is created with `users.approved = 0` instead of `1`, and cannot sign in until approved:

- `POST /api/auth/login` `403`s a correct password for an unapproved account (`"This account is pending approval..."`), sets no session cookie.
- `GET /api/auth/oidc/callback` likewise refuses to start a session for an unapproved account, `403` with an explanatory page instead of the usual redirect to `/`.
- Approving is `POST /api/users/:id/approve`, reachable by `admin` **or** `operator` (`auth.requireAnyRole(['admin', 'operator'])`, not the admin-only gate the rest of user management uses): approving a coworker's new account is meant to be an everyday action, not one that needs an admin specifically. It is idempotent (approving an already-approved account is a no-op `200`, not an error). `GET /api/users/pending` (same admin-or-operator access) lists every unapproved account for the Users page's "Pending approval" section, which every role that can reach `/users` sees, even if the rest of the page (create/edit/delete, full user list) is hidden from a non-admin (`client/src/pages/Users.jsx`).
- Only affects OIDC auto-provisioning. An account an admin creates directly via `POST /api/users` is always `approved = 1` regardless of the setting: an admin creating the account has already made the call this workflow exists to gate. An existing account is never retroactively affected by toggling the setting later, only a newly auto-provisioned one from that point on.

## Print approval

A separate, per-account setting from the one above: `require_uploader_approval` gates whether an account can sign in at all; `users.requires_print_approval` (admin-only, `PUT /api/users/:id`, off by default for every account) instead gates whether *that specific uploader's* own G-code uploads need review before the scheduler will dispatch them. Not a role, not a global switch: two uploaders can have opposite settings on the same farm, e.g. a trusted regular vs. a script account or a new hire.

- `POST /api/gcodes/upload` reads the uploading account's `requires_print_approval` at upload time and sets the new row's `gcodes.approved` accordingly: `0` (pending) if set, the normal `1` otherwise. See [docs/database.md](database.md)'s `gcodes` table.
- An unapproved G-code is not a dispatch candidate at all, the same mechanism as one with no matching printer: excluded in the scheduler's candidate query and reflected in `GET /api/parts/:id/dispatch-status`'s reasons (`"<filename>: pending operator approval before it can be dispatched"`). No new hold or job state; the part just has nothing eligible to dispatch until the G-code is approved.
- Approving is `POST /api/gcodes/:id/approve`, admin-or-operator (`auth.requireAnyRole(['admin', 'operator'])`), the same day-to-day-work bar as approving a pending account above. Idempotent: approving an already-approved G-code is a no-op `200`. Shown as a "Pending approval" badge with an Approve button next to the G-code on the Projects page's part detail (`client/src/pages/Projects.jsx`), visible to whoever can approve it.
- Toggling the flag only affects G-code uploaded from that point on; an uploader's past G-codes keep whatever `approved` value they were created with.

## First run: bootstrap

A fresh install has zero users. `GET /api/auth/status` reports `needsBootstrap: true`, and the login page shows a "create the admin account" form instead of a login form. `POST /api/auth/bootstrap` is only accepted while the `users` table is empty: once any account exists, it always 403s. The account it creates is always `admin`; there is no other way to create the first account.

## Password login

Standard email + password, verified with bcrypt (`server/auth.js`, `BCRYPT_ROUNDS = 12`). A successful login creates a `sessions` row and sets the cookie; `POST /api/auth/logout` deletes that row and clears the cookie, so a logout takes effect immediately rather than waiting for the cookie to expire.

## OIDC (single sign-on)

Generic OIDC support via [`openid-client`](https://github.com/panva/openid-client) v5 (the CommonJS-compatible major version: this codebase is `require()`-only throughout, and v6 dropped CJS support), so any OIDC-compliant provider works without code changes: Okta, Authentik, Auth0, Keycloak, Google Workspace, etc.

**Configuration**: four environment variables, all required for OIDC to activate:

```bash
OIDC_ISSUER_URL=https://your-idp.example.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=http://your-farm-host:3000/api/auth/oidc/callback
```

If any is missing, `oidc.isConfigured()` is false: the login page hides the "Sign in with SSO" button, and `GET /api/auth/oidc/login` returns 404 rather than attempting IdP discovery. The provider's issuer and client are discovered lazily on first use, not at server startup, so a farm that never sets these env vars never makes a network call to an identity provider it isn't using: the same lazy-load pattern `server/drivers/index.js` uses for printer connectors.

**Flow:** `GET /api/auth/oidc/login` starts an authorization-code-with-PKCE flow and redirects to the provider. The `state`/`code_verifier` pair for that one attempt lives in an in-memory `Map` (keyed by a short-lived `pfm_oidc_flow` cookie, 10-minute TTL): not the database, since this app is a single Express process per farm and the flow is over in seconds. `GET /api/auth/oidc/callback` exchanges the code, then resolves a local user in this order:

1. `oidc_subject` matches an existing user: sign them in.
2. No `oidc_subject` match, but `email` matches an existing (password-based) account: link `oidc_subject` onto that account rather than creating a duplicate, then sign them in.
3. No match at all: auto-provision a brand new account, always as `uploader` (the default, least-privileged role, see Roles above). OIDC login can never hand out `admin` by itself; an admin must explicitly promote the account afterward (Users page) if it needs more access.

## Automatic SSO redirect

An admin can turn on the `auto_sso_redirect` setting (Settings → Single Sign-On, or `PUT /api/settings/auto_sso_redirect`, admin-only: `403` for an operator) so the login page skips the local email/password form entirely and redirects straight to the IdP. `GET /api/auth/status` reports the effective value as `autoSsoRedirect`, which is the raw setting **AND** `oidc.isConfigured()`: if OIDC's environment variables aren't set, this is always `false` regardless of the setting, so a farm can never end up redirecting a visitor into a login flow that 404s.

**`/backup-login`** always shows the local password form, ignoring the redirect: the fallback for when the identity provider is down, misconfigured, or an admin needs to sign in locally before OIDC is fully set up. It is not a separate auth mechanism: it is the same `POST /api/auth/login` password check every account already has, just reached at a path the redirect doesn't intercept. `client/src/pages/Login.jsx` checks `window.location.pathname` directly for this (it renders before `client/src/App.jsx` mounts its router, so there is no React Router route for it).

## Client behavior

`AuthContext` (`client/src/AuthContext.jsx`) calls `GET /api/auth/me` once on mount. `App.jsx` renders `Login` for a logged-out visitor and the normal app otherwise: no page-level guards are needed since data pages never fetch while logged out. A session expiring while the app is already open (30-day TTL, a rare edge case) is not specially handled: background poll fetches already swallow errors (`.catch(() => {})` per the existing convention), so the app quietly stops updating until the next full reload re-checks `/api/auth/me` and redirects to login.

## What this does not do (yet)

- No general per-route permission scoping: `blockRole('uploader')` on the two set-ready routes is a single, specific carve-out, not a broader permission system. An operator has the same farm-operation access an admin does, and an uploader has the same access as an operator apart from that one carve-out.
- No API key scoping (read-only keys, route-restricted keys): every key is full access, matching its owner's role.
- No password reset flow (an admin resets a user's password via `PUT /api/users/:id`) and no "forgot password" email, since this app has no outbound email integration.
