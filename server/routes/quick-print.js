// Quick Print: upload one sliced file from the app and print it once, without
// building a project first. POST /api/quick-print (multipart: file, optional
// printer_id, optional parts_per_plate).
//
// It goes through the same path as a slicer upload (server/routes/slicer-upload.js):
// one Part (target = one plate) in the uploader's own "Uploads: <name>" project,
// one G-code, and the scheduler dispatches it like any other queued work. Nothing
// here touches parts.completed_qty: the part is credited through the normal
// Set Ready flow after a real print, exactly like every other part.
//
// With printer_id the print is pinned to that printer (gcodes.target_printer_id);
// without it, any eligible printer of the file's model takes it. The uploader's
// user group is enforced: can_quick_print, its allowed printers, plate cap, and
// requires_approval (an unapproved quick print waits for an operator).

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
      const partsPerPlate = req.body.parts_per_plate ? parseInt(req.body.parts_per_plate, 10) : 1;
      if (!Number.isInteger(partsPerPlate) || partsPerPlate < 1 || partsPerPlate > 9999) {
        return reject(400, 'parts_per_plate must be a positive whole number');
      }
      if (perms && perms.max_plates_per_upload && partsPerPlate > perms.max_plates_per_upload) {
        return reject(403, `Your user group allows at most ${perms.max_plates_per_upload} parts per plate per upload`);
      }

      const models = db.prepare('SELECT model_id, label FROM printer_models').all();
      const buf = fs.readFileSync(req.file.path);
      const headerModelName = readPrinterModelName(displayName, buf);
      const headerModel = headerModelName ? matchRegistryModel(headerModelName, models) : null;

      // Target printer, if the operator picked one.
      let targetPrinter = null;
      const rawPrinterId = req.body.printer_id;
      if (rawPrinterId !== undefined && rawPrinterId !== '' && rawPrinterId !== 'any') {
        targetPrinter = db.prepare('SELECT * FROM printers WHERE id = ?').get(parseInt(rawPrinterId, 10));
        if (!targetPrinter) return reject(404, 'Printer not found');
        if (!targetPrinter.is_active) return reject(409, `${targetPrinter.name} is decommissioned`);
        if (!auth.printerAllowed(perms, targetPrinter)) {
          return reject(403, `Your user group is not allowed to print on ${targetPrinter.name}`);
        }
      }

      // Model: the chosen printer's, else the file's own header, else the only
      // active model on the farm. Never guessed beyond that.
      let printerModel;
      if (targetPrinter) {
        if (headerModel && headerModel !== targetPrinter.model) {
          return reject(400, `This file was sliced for ${headerModelName}, but ${targetPrinter.name} is a ${targetPrinter.model}`);
        }
        printerModel = targetPrinter.model;
      } else {
        const farmModels = db.prepare('SELECT DISTINCT model FROM printers WHERE is_active = 1').all().map(r => r.model);
        if (headerModel) {
          if (!farmModels.includes(headerModel)) return reject(400, `No active ${headerModel} printers on the farm`);
          printerModel = headerModel;
        } else if (farmModels.length === 1) {
          printerModel = farmModels[0];
        } else {
          return reject(400, 'Could not tell which printer model this file is for: pick a printer, or slice with a printer profile that names the model');
        }
        // A restricted group needs at least one allowed printer of that model.
        const usable = db.prepare('SELECT id, group_name FROM printers WHERE model = ? AND is_active = 1').all(printerModel);
        if (!usable.some(p => auth.printerAllowed(perms, p))) {
          return reject(403, `Your user group is not allowed to print on any ${printerModel} printer`);
        }
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
          INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at, created_by_user_id, created_by_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(project.id, stripExtension(displayName), partsPerPlate, (maxRow?.max ?? -1) + 1, now, now, user.id, user.name).lastInsertRowid;

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
        pending_approval: !approved,
      });
    });
  });

  return router;
};
