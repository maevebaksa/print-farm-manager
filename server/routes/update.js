// Software Update (Settings page, admin-only): shows the running build's git
// commit against the latest commit on a configured GitHub repo, and,
// opt-in only, a trigger that runs the actual update.
//
// The trigger requires the operator to have bind-mounted the Docker socket
// and the compose project directory into the container (see
// docker-compose.yml's commented-out example): this router does nothing
// privileged on its own, it only becomes reachable once those mounts exist.
// See docs/deployment.md for the full security tradeoff (Docker socket
// access is equivalent to root on the host) before enabling it.

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const auth = require('../auth');

const DOCKER_SOCK = '/var/run/docker.sock';
const DEPLOY_DIR = '/deploy';
const UPDATE_LOG = path.join(__dirname, '..', 'data', 'update.log');

// GET https://api.github.com/repos/<repo>/commits/main, no auth (public repo,
// unauthenticated GitHub API rate limits are ample for one check per Settings
// page load). Returns the full 40-character commit SHA, or null on any
// failure (private/nonexistent repo, network error, rate limit): never
// throws, this is advisory information, not something dispatch depends on.
function fetchLatestCommit(repo) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${repo}/commits/main`,
      { headers: { 'User-Agent': 'print-farm-manager-update-check' }, timeout: 8000 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body).sha || null); }
          catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// True only when the operator has bind-mounted both the Docker socket and
// the compose project directory (with docker-compose.yml in it) into the
// container: the two things POST /trigger needs to actually run anything.
// Neither is present in the plain, unmodified docker-compose.yml, so the
// trigger button simply does not appear for an operator who hasn't
// deliberately opted into the tradeoff.
function canTrigger() {
  return fs.existsSync(DOCKER_SOCK) && fs.existsSync(path.join(DEPLOY_DIR, 'docker-compose.yml'));
}

module.exports = (db) => {
  // A fresh router per factory call, not one at module level: a shared
  // module-level router accumulates one handler per call, and the first one
  // (bound to the first db it was given) answers every request after it.
  // Harmless with one production call, wrong in tests that build a new app
  // and database per test (and the reason this route's tests failed in CI).
  const router = express.Router();
  router.get('/status', auth.requireRole('admin'), async (req, res) => {
    const repoSetting = db.prepare("SELECT value FROM settings WHERE key = 'update_repo'").get();
    const repo = repoSetting?.value || null;
    const currentCommit = process.env.GIT_COMMIT || null;
    const latestCommit = repo ? await fetchLatestCommit(repo) : null;

    res.json({
      repo,
      currentCommit,
      latestCommit,
      // Both must be known, real commits to compare; a missing repo setting
      // or a failed GitHub fetch means "unknown", not "up to date".
      updateAvailable: !!(currentCommit && latestCommit && currentCommit !== latestCommit),
      canTrigger: canTrigger(),
    });
  });

  // Starts the update and returns immediately: `docker compose up -d`, once
  // the Docker daemon has accepted it, proceeds independently of whether this
  // very container (and the process handling this request) survives to see
  // it finish, which it usually won't. Waiting for the child process to exit
  // before responding would just mean the response never arrives.
  router.post('/trigger', auth.requireRole('admin'), (req, res) => {
    if (!canTrigger()) {
      return res.status(409).json({
        error: 'Update trigger is not available: the Docker socket and compose project directory must be bind-mounted first. See docs/deployment.md.',
      });
    }

    const logStream = fs.createWriteStream(UPDATE_LOG, { flags: 'a' });
    logStream.write(`\n[update] ${new Date().toISOString()} triggered by ${req.user.email}\n`);

    const child = spawn('sh', ['-c', 'docker compose pull && docker compose up -d'], {
      cwd: DEPLOY_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    child.unref();

    res.json({ started: true, message: 'Update started. This server will restart shortly once the new image is running.' });
  });

  return router;
};
