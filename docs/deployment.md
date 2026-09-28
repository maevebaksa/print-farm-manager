# Deployment: Docker, and the Software Update feature

## Purpose

Covers running Print Farm Manager under Docker (`docker-compose.yml`, the production image `docker-publish.yml` builds, see [docs/docker-publish.md](docker-publish.md)), and the optional in-app Software Update feature (Settings → Software Update, `server/routes/update.js`) that checks for and can trigger a new deployment from inside the running app.

For the Windows bare-metal install path (`update.bat`, PM2), see [docs/installation.md](installation.md) instead; the Software Update feature described here is Docker-only.

## Software Update: what it shows, always

Every deployment, with no configuration, gets a read-only status panel:

- **Running commit**: the git commit this image was built from (`GET /api/update/status`'s `currentCommit`, from the `GIT_COMMIT` environment variable baked in at build time, see [docs/docker-publish.md](docker-publish.md#git_commit-build-arg)). `unknown` for a locally-built image (`docker compose up --build` doesn't set this build-arg).
- **Latest commit**: fetched live from `GET https://api.github.com/repos/<update_repo>/commits/main`, unauthenticated (ample rate limit for one check per Settings page load). `update_repo` is an admin-only setting (`PUT /api/settings/update_repo`, `owner/repo` shape, e.g. `maevebaksa/print-farm-manager`); until it is set, this and `updateAvailable` are simply unknown, not "up to date".
- **Update available**: `true` only when both commits are known and differ.

This part requires nothing beyond setting `update_repo` and works on every Docker deployment, published image or locally built.

## Software Update: the actual trigger (opt-in, and why it's opt-in)

The "Update now" button, and the `POST /api/update/trigger` route behind it, only appear/work once the operator has bind-mounted two things into the container (`docker-compose.yml` has the exact lines, commented out by default):

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
  - .:/deploy:ro
```

**Read this before uncommenting those lines.** Mounting the Docker socket gives the container full control over the Docker daemon on the host: it can create, start, stop, or remove any container, mount any host path into a new one, and so on. This is **equivalent to unrestricted root on the host**, not scoped to this one container or this one application. Anyone with admin access to Print Farm Manager (or anyone who manages to compromise it) can do anything to the host it runs on, not just update this container. The `:ro` (read-only) flag on the project-directory mount does not reduce this risk in any meaningful way: a process that can already talk to the Docker socket does not need write access to your files to cause damage.

This tradeoff is deliberate and the feature is opt-in specifically so a farm running the plain, unmodified `docker-compose.yml` never has this capability at all, only an operator who has read this and decided the convenience is worth it on their specific setup (a home network, a machine nothing else sensitive runs on, etc.).

### What actually happens when triggered

`canTrigger()` in `server/routes/update.js` checks that both `/var/run/docker.sock` and `/deploy/docker-compose.yml` exist inside the container before the route will do anything; `POST /trigger` 409s otherwise. When both are present, triggering:

1. Responds to the HTTP request immediately with `{ started: true }`, before the update itself is known to have succeeded. This is deliberate, not a shortcut: `docker compose up -d`, once the Docker daemon has accepted it, proceeds independently of whether the container issuing the command (this one) survives to see it finish, which it usually will not, since that command's whole point is to replace this container. Waiting for the child process to exit before responding would mean the response almost never arrives.
2. Spawns `docker compose pull && docker compose up -d` (`sh -c`, detached, cwd `/deploy`) using the Docker CLI and Compose plugin installed in the image specifically for this (see `Dockerfile`'s `runtime` stage) against the bind-mounted copy of the real `docker-compose.yml`, so the recreated container gets exactly the same configuration (network mode, volumes, environment) already defined there, not a reconstruction of it via raw Docker API calls that could get something wrong.
3. Appends output to `server/data/update.log` inside the container, which is the same `farm-data` named volume the database lives in, so the log survives the container being replaced and can be read from the new container afterward to confirm what happened.

### Checking on a triggered update

Since the HTTP response can't confirm success, check `server/data/update.log` (inside the container, or via `docker exec`/a bind mount) after triggering, or just reload the Settings page after a minute or two and let the status check tell you whether `currentCommit` now matches `latestCommit`.
