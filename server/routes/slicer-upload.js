// Slicer-compatible upload endpoint, one base URL per printer group:
//
//   http://<farm>:3000/slicer/<group name>
//
// Paste that into PrusaSlicer or OrcaSlicer as a physical printer's host, with
// one of your API keys (Account > API Keys) as the API key. Both host types
// work against the same URL:
//
//   OctoPrint (PrusaSlicer "OctoPrint", OrcaSlicer "Octo/Klipper"), as called by
//   PrusaSlicer 2.9.0 src/slic3r/Utils/OctoPrint.cpp and OrcaSlicer's copy:
//     GET  <base>/api/version        connection test: needs "api", and "text"
//                                    starting with "OctoPrint"
//     POST <base>/api/files/local    multipart: file, print, path (+ select)
//   Moonraker (OrcaSlicer "Moonraker"), as called by OrcaSlicer
//   src/slic3r/Utils/Moonraker.cpp:
//     GET  <base>/server/info        connection test: needs result.klippy_state
//     GET  <base>/server/files/roots optional storage roots
//     POST <base>/server/files/upload multipart: file, root, plateindex
//     POST <base>/printer/print/start { filename } after "upload and print"
//
// Auth is the slicer's API key field, sent as X-Api-Key by both slicers (an
// Authorization: Bearer key works too): a farm API key acts as its owner.
//
// An upload never goes straight to a printer: it becomes a queued print that
// the scheduler dispatches like any other, restricted to this group's printers.
// Each upload creates one Part (named after the file, one plate) in the
// uploading user's own "Uploads: <name>" project, created on first use. The
// printer model comes from the file's own header (printer_model), falling back
// to the group's model when every printer in it is the same model. "Upload"
// and "Upload and print" both queue the print: the farm, not the slicer,
// decides when it runs.
//
// Mounted in server/index.js ahead of the SPA catch-all (these are GET paths
// outside /api), with the scheduler passed lazily since it only exists once
// the server is listening.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../auth');
const { readPrinterModelName, matchRegistryModel, readPrintStats } = require('../gcode-metadata');
const { safeFilename, displayFilename } = require('../safe-filename');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const ACCEPTED_EXTENSIONS = ['.gcode', '.gco', '.g', '.bgcode', '.3mf'];
// What /api/version reports. PrusaSlicer only accepts a "text" that starts
// with "OctoPrint" (OctoPrint::validate_version_text).
const VERSION_INFO = { api: '0.1', server: '1.10.0', text: 'OctoPrint 1.10.0 (Print Farm Manager)' };

// Stored names never trust the client-supplied filename: see server/safe-filename.js.
const upload = multer({
  storage: multer.diskStorage({
    destination: GCODE_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${safeFilename(file.originalname)}`),
  }),
});

function stripExtension(name) {
  return name.replace(/\.gcode\.3mf$/i, '').replace(/\.(gcode|gco|g|bgcode|3mf)$/i, '');
}

// "4x Bracket.gcode" style plate count prefix; otherwise one part per plate.
function partsPerPlateFromName(name) {
  const m = name.match(/^(\d+)x[\s_]/i);
  const n = m ? parseInt(m[1], 10) : 1;
  return n > 0 && n < 10000 ? n : 1;
}

module.exports = (db, getScheduler = () => null) => {
  const router = express.Router({ mergeParams: true });

  // Slicer auth: API key in X-Api-Key (both slicers) or a Bearer header.
  function slicerAuth(req, res, next) {
    const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    const key = (req.headers['x-api-key'] || (bearer && bearer[1]) || '').trim();
    if (!key) return res.status(401).json({ error: 'API key required: set it in the slicer (Account > API Keys in Print Farm Manager)' });
    const user = auth.getUserByApiKey(db, key);
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    if (user.approved === 0) return res.status(403).json({ error: 'This account is pending approval' });
    req.user = { ...auth.publicUser(user), permissions: auth.resolvePermissions(db, user) };
    next();
  }

  function requireGroup(req, res, next) {
    const group = db.prepare('SELECT name FROM printer_groups WHERE name = ?').get(req.params.group);
    if (!group) return res.status(404).json({ error: `Unknown printer group "${req.params.group}"` });
    req.groupName = group.name;
    next();
  }

  const base = '/:group';
  router.use(base, slicerAuth, requireGroup);

  // ── Connection tests ──────────────────────────────────────────────────────
  router.get(`${base}/api/version`, (_req, res) => res.json(VERSION_INFO));
  router.get(`${base}/api/server`, (_req, res) => res.json({ version: VERSION_INFO.server, safemode: null }));
  router.get(`${base}/server/info`, (_req, res) => res.json({
    result: { klippy_connected: true, klippy_state: 'ready', moonraker_version: 'print-farm-manager' },
  }));
  router.get(`${base}/server/files/roots`, (_req, res) => res.json({
    result: [{ name: 'gcodes', path: '/gcodes', permissions: 'rw' }],
  }));

  // Orca sends this after a Moonraker "upload and print". The upload already
  // queued the print, so there is nothing more to start.
  router.post(`${base}/printer/print/start`, express.json(), (_req, res) => res.json({ result: 'ok' }));

  // ── Upload ────────────────────────────────────────────────────────────────
  function handleUpload(flavor) {
    return (req, res) => {
      upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded (multipart field "file")' });

        const reject = (status, error) => {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          return res.status(status).json({ error });
        };

        const displayName = displayFilename(req.file.originalname);
        const lower = displayName.toLowerCase();
        if (!ACCEPTED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
          return reject(415, `Unsupported file type: upload .gcode, .bgcode, or a sliced .3mf`);
        }

        // Printer model: the file's own header first, then the group's model if
        // the group only has one. Never guessed beyond that.
        const models = db.prepare('SELECT model_id, label FROM printer_models').all();
        const groupModels = db.prepare(
          'SELECT DISTINCT model FROM printers WHERE group_name = ? AND is_active = 1'
        ).all(req.groupName).map(r => r.model);
        const buf = fs.readFileSync(req.file.path);
        const headerModelName = readPrinterModelName(displayName, buf);
        const headerModel = headerModelName ? matchRegistryModel(headerModelName, models) : null;

        let printerModel = null;
        if (headerModel) {
          if (groupModels.length > 0 && !groupModels.includes(headerModel)) {
            return reject(400, `This file was sliced for ${headerModelName}, but group "${req.groupName}" has no ${headerModel} printers`);
          }
          printerModel = headerModel;
        } else if (groupModels.length === 1) {
          printerModel = groupModels[0];
        } else if (groupModels.length === 0) {
          return reject(400, `Group "${req.groupName}" has no active printers, and the file does not say which printer it was sliced for`);
        } else {
          return reject(400, `Could not tell which printer model this file is for (group "${req.groupName}" has ${groupModels.join(', ')}). Slice with a printer profile whose printer_model matches one of them.`);
        }

        // User-group limits: an allowed-printer list must include at least one
        // active printer in this group.
        const perms = req.user.permissions;
        if (perms && (perms.allowed_printer_ids || perms.allowed_printer_groups)) {
          const groupPrinters = db.prepare(
            'SELECT id, group_name FROM printers WHERE group_name = ? AND is_active = 1'
          ).all(req.groupName);
          if (!groupPrinters.some(p => auth.printerAllowed(perms, p))) {
            return reject(403, `Your user group is not allowed to print on any printer in group "${req.groupName}"`);
          }
        }

        const stats = readPrintStats(displayName, buf); // print time, grams, filament type from the header
        const user = req.user;
        const now = Date.now();
        const partsPerPlate = partsPerPlateFromName(displayName);
        const approved = (user.requires_print_approval || (perms && perms.requires_approval)) ? 0 : 1;
        const projectName = `Uploads: ${user.name}`;

        let gcodeId;
        db.transaction(() => {
          let project = db.prepare(
            'SELECT * FROM projects WHERE created_by_user_id = ? AND name = ? ORDER BY id LIMIT 1'
          ).get(user.id, projectName);
          if (!project) {
            const r = db.prepare(`
              INSERT INTO projects (name, description, status, priority, created_at, updated_at, created_by_user_id, created_by_name)
              VALUES (?, ?, 'active', 0, ?, ?, ?, ?)
            `).run(projectName, 'Prints sent straight from a slicer', now, now, user.id, user.name);
            project = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid);
          } else if (project.status === 'completed') {
            // Same as adding a part through POST /api/parts: new unmet work reopens it.
            db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
          }

          const maxRow = db.prepare('SELECT MAX(sort_order) AS max FROM parts WHERE project_id = ?').get(project.id);
          const partId = db.prepare(`
            INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at, created_by_user_id, created_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(project.id, stripExtension(displayName), partsPerPlate, (maxRow?.max ?? -1) + 1, now, now, user.id, user.name).lastInsertRowid;

          gcodeId = db.prepare(`
            INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, allowed_groups, approved,
                                est_print_secs, material_grams, material_type,
                                uploaded_by_user_id, uploaded_by_name, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(partId, printerModel, displayName, req.file.filename, partsPerPlate,
                 JSON.stringify([req.groupName]), approved,
                 stats.est_print_secs, stats.material_grams, stats.material_type,
                 user.id, user.name, now).lastInsertRowid;
        })();

        console.log(`[slicer] ${user.name} queued "${displayName}" for ${printerModel} in group "${req.groupName}"${approved ? '' : ' (pending approval)'}`);
        const scheduler = getScheduler();
        if (scheduler && approved) scheduler.sweepIdlePrinters();

        if (flavor === 'moonraker') {
          return res.status(201).json({
            result: {
              item: { path: displayName, root: 'gcodes' },
              print_started: false,
              print_queued: true,
              action: 'create_file',
              farm_gcode_id: gcodeId,
            },
          });
        }
        const resource = `${req.protocol}://${req.get('host')}${req.baseUrl}/${encodeURIComponent(req.groupName)}/api/files/local/${encodeURIComponent(displayName)}`;
        res.set('Location', resource);
        return res.status(201).json({
          files: { local: { name: displayName, path: displayName, origin: 'local', refs: { resource } } },
          done: true,
          effectiveSelect: false,
          effectivePrint: false, // queued, not printing yet: the farm dispatches it
          farm_gcode_id: gcodeId,
        });
      });
    };
  }

  router.post(`${base}/api/files/local`, handleUpload('octoprint'));
  router.post(`${base}/server/files/upload`, handleUpload('moonraker'));

  return router;
};

