// Quick Print: upload one sliced file from the app and print it once, without
// building a project first. POST /api/quick-print (multipart: file, optional
// printer_id, optional printer_model, optional priority, optional parts_per_plate).
//
// It goes through the same path as a slicer upload (server/routes/slicer-upload.js):
// one Part (target = one plate) in the uploader's own "Uploads: <name>" project,
// one G-code, and the scheduler dispatches it like any other queued work. Nothing
// here touches parts.completed_qty: the part is credited through the normal
// Set Ready flow after a real print, exactly like every other part.
//
// Anyone may leave the printer unset (auto-detected from the file's own header,
// or the farm's only active model) or narrow it to a printer type via
// printer_model ("any Mini", still shares across every printer of that type).
// Pinning to one exact printer_id, or marking priority (jumps the queue, same
// as PUT /api/parts/:id/priority-override), is operator/admin only: a specific
// machine or the front of the line can starve other users' work, so a plain
// uploader cannot claim either. The uploader's user group is still enforced:
// can_quick_print, its allowed printers, and requires_approval (an unapproved
// quick print waits for an operator).

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../auth');
const { readPrinterModelName, matchRegistryModel, readPrintStats } = require('../gcode-metadata');
const { safeFilename, displayFilename } = require('../safe-filename');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const ACCEPTED_EXTENSIONS = ['.gcode', '.gco', '.g', '.bgcode', '.3mf'];

const upload = multer({
  storage: multer.diskStorage({
    destination: GCODE_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${safeFilename(file.originalname)}`),
  }),
});

function stripExtension(name) {
  return name.replace(/\.gcode\.3mf$/i, '').replace(/\.(gcode|gco|g|bgcode|3mf)$/i, '');
}

module.exports = (db, scheduler = null) => {
  const router = express.Router();

  router.post('/', auth.requirePermission('can_quick_print', 'Your user group cannot use Quick Print'), (req, res) => {
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
        return reject(415, 'Unsupported file type: upload .gcode, .bgcode, or a sliced .3mf');
      }

      const perms = req.user.permissions;
      // Picking one exact machine, or marking a quick print priority, both let
      // one person jump ahead of or monopolize shared hardware, reserved for
      // operator/admin. Anyone may still narrow to a printer type ("any Mini"):
      // that's just being explicit about what the auto-detected model would
      // pick anyway, and still shares fairly across every printer of that type.
      const isOperatorPlus = req.user.role === 'admin' || req.user.role === 'operator';
      const partsPerPlate = req.body.parts_per_plate ? parseInt(req.body.parts_per_plate, 10) : 1;
      if (!Number.isInteger(partsPerPlate) || partsPerPlate < 1 || partsPerPlate > 9999) {
        return reject(400, 'parts_per_plate must be a positive whole number');
      }
      const models = db.prepare('SELECT model_id, label FROM printer_models').all();
      const buf = fs.readFileSync(req.file.path);
      const headerModelName = readPrinterModelName(displayName, buf);
      const headerModel = headerModelName ? matchRegistryModel(headerModelName, models) : null;

      // Target printer, if an operator/admin picked one.
      let targetPrinter = null;
      const rawPrinterId = req.body.printer_id;
      if (rawPrinterId !== undefined && rawPrinterId !== '' && rawPrinterId !== 'any') {
        if (!isOperatorPlus) return reject(403, 'Only an operator or admin may target a specific printer');
        targetPrinter = db.prepare('SELECT * FROM printers WHERE id = ?').get(parseInt(rawPrinterId, 10));
        if (!targetPrinter) return reject(404, 'Printer not found');
        if (!targetPrinter.is_active) return reject(409, `${targetPrinter.name} is decommissioned`);
        if (!auth.printerAllowed(perms, targetPrinter)) {
          return reject(403, `Your user group is not allowed to print on ${targetPrinter.name}`);
        }
      }

      // Requested printer type ("any Mini"), if picked and no specific printer
      // was. Anyone may narrow to a type; it still queues for any eligible
      // printer of that model, same as the auto-detected path below.
      let requestedModel = null;
      const rawModel = req.body.printer_model;
      if (!targetPrinter && rawModel !== undefined && rawModel !== '' && rawModel !== 'any') {
        requestedModel = rawModel;
      }

      // Model: the chosen printer's, else the chosen type, else the file's own
      // header, else the only active model on the farm. Never guessed beyond that.
      let printerModel;
      if (targetPrinter) {
        if (headerModel && headerModel !== targetPrinter.model) {
          return reject(400, `This file was sliced for ${headerModelName}, but ${targetPrinter.name} is a ${targetPrinter.model}`);
        }
        printerModel = targetPrinter.model;
      } else if (requestedModel) {
        if (headerModel && headerModel !== requestedModel) {
          return reject(400, `This file was sliced for ${headerModelName}, not ${requestedModel}`);
        }
        const usable = db.prepare('SELECT id, group_name FROM printers WHERE model = ? AND is_active = 1').all(requestedModel);
        if (usable.length === 0) return reject(400, `No active ${requestedModel} printers on the farm`);
        if (!usable.some(p => auth.printerAllowed(perms, p))) {
          return reject(403, `Your user group is not allowed to print on any ${requestedModel} printer`);
        }
        printerModel = requestedModel;
      } else {
        const farmModels = db.prepare('SELECT DISTINCT model FROM printers WHERE is_active = 1').all().map(r => r.model);
        if (headerModel) {
          if (!farmModels.includes(headerModel)) return reject(400, `No active ${headerModel} printers on the farm`);
          printerModel = headerModel;
        } else if (farmModels.length === 1) {
          printerModel = farmModels[0];
        } else {
          return reject(400, 'Could not tell which printer model this file is for: pick a printer type, or slice with a printer profile that names the model');
        }
        // A restricted group needs at least one allowed printer of that model.
        const usable = db.prepare('SELECT id, group_name FROM printers WHERE model = ? AND is_active = 1').all(printerModel);
        if (!usable.some(p => auth.printerAllowed(perms, p))) {
          return reject(403, `Your user group is not allowed to print on any ${printerModel} printer`);
        }
      }

      // Priority: jumps this quick print ahead of the normal queue order, same
      // as PUT /api/parts/:id/priority-override. Operator/admin only, same as
      // that route.
      const rawPriority = req.body.priority;
      const wantsPriority = rawPriority === 'true' || rawPriority === true || rawPriority === '1';
      if (wantsPriority && !isOperatorPlus) {
        return reject(403, 'Only an operator or admin may mark a quick print as priority');
      }

      const stats = readPrintStats(displayName, buf);
      const user = req.user;
      const now = Date.now();
      const approved = (user.requires_print_approval || (perms && perms.requires_approval)) ? 0 : 1;
      const projectName = `Uploads: ${user.name}`;

      let ids;
      db.transaction(() => {
        let project = db.prepare(
          'SELECT * FROM projects WHERE created_by_user_id = ? AND name = ? ORDER BY id LIMIT 1'
        ).get(user.id, projectName);
        if (!project) {
          const r = db.prepare(`
            INSERT INTO projects (name, description, status, priority, created_at, updated_at, created_by_user_id, created_by_name)
            VALUES (?, ?, 'active', 0, ?, ?, ?, ?)
          `).run(projectName, 'Quick prints and prints sent straight from a slicer', now, now, user.id, user.name);
          project = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid);
        } else if (project.status === 'completed') {
          db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
        }

        const maxRow = db.prepare('SELECT MAX(sort_order) AS max FROM parts WHERE project_id = ?').get(project.id);
        const partId = db.prepare(`
          INSERT INTO parts (project_id, name, target_qty, sort_order, priority_override, created_at, updated_at, created_by_user_id, created_by_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(project.id, stripExtension(displayName), partsPerPlate, (maxRow?.max ?? -1) + 1, wantsPriority ? 1 : 0, now, now, user.id, user.name).lastInsertRowid;

        const gcodeId = db.prepare(`
          INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, approved, target_printer_id,
                              est_print_secs, material_grams, material_type,
                              uploaded_by_user_id, uploaded_by_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(partId, printerModel, displayName, req.file.filename, partsPerPlate, approved,
               targetPrinter ? targetPrinter.id : null,
               stats.est_print_secs, stats.material_grams, stats.material_type,
               user.id, user.name, now).lastInsertRowid;
        ids = { project_id: project.id, part_id: partId, gcode_id: gcodeId };
      })();

      console.log(`[quick-print] ${user.name} queued "${displayName}" for ${targetPrinter ? targetPrinter.name : printerModel}${approved ? '' : ' (pending approval)'}`);
      if (scheduler && approved) scheduler.sweepIdlePrinters();

      res.status(201).json({
        ...ids,
        filename: displayName,
        printer_model: printerModel,
        target_printer_id: targetPrinter ? targetPrinter.id : null,
        priority: wantsPriority,
        pending_approval: !approved,
      });
    });
  });

  return router;
};
