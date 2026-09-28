// Reads slicer metadata from a sliced file's own header/footer comments, never
// from its filename. Formats, all read from real slicer output or source:
//
//   .gcode   PrusaSlicer and OrcaSlicer write "; key = value" comment lines: a
//            short summary near the top and the full config block at the very
//            end ("; printer_model = MK4S", "; filament_type = PLA", ...).
//   .bgcode  PrusaSlicer's binary container: the same keys as INI metadata
//            blocks (gcode-convert.js readBgcodeMetadata).
//   .3mf     A sliced OrcaSlicer / Bambu Studio project: the plate's G-code at
//            Metadata/plate_<N>.gcode carries the same comment lines.
//
// Only the head and tail of a plain G-code file are scanned: the metadata
// lives there, and a multi-hundred-MB file never needs reading in full.
const { readBgcodeMetadata, threeMfToGcode } = require('./gcode-convert');

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024; // PrusaSlicer's trailing config block alone can pass 60 KB

// "; key = value" (PrusaSlicer/Orca config) and ";key: value" / "; key: value"
// (summary lines some slicers use). The first value seen for a key wins, so the
// head's summary takes precedence over a repeated key in the tail.
function parseCommentLines(text, into) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(';')) continue;
    const body = line.replace(/^;+\s*/, '');
    const m = body.match(/^([^=:]{1,80}?)\s*[=:]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    if (!key || into.has(key)) continue;
    into.set(key, m[2].trim());
  }
  return into;
}

function commentsFromPlainGcode(buf) {
  const map = new Map();
  if (buf.length <= HEAD_BYTES + TAIL_BYTES) return parseCommentLines(buf.toString('latin1'), map);
  parseCommentLines(buf.subarray(0, HEAD_BYTES).toString('latin1'), map);
  return parseCommentLines(buf.subarray(buf.length - TAIL_BYTES).toString('latin1'), map);
}

// Returns a Map of lowercased metadata keys to string values for any supported
// file, or an empty Map when nothing can be read. Never throws.
function readMetadataMap(filename, buf) {
  try {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.bgcode')) {
      const meta = readBgcodeMetadata(buf);
      const map = new Map();
      for (const [k, v] of [...meta.printer, ...meta.print, ...meta.file, ...meta.slicer]) {
        const key = k.trim().toLowerCase();
        if (!map.has(key)) map.set(key, v.trim());
      }
      return map;
    }
    if (lower.endsWith('.3mf')) return commentsFromPlainGcode(threeMfToGcode(buf));
    return commentsFromPlainGcode(buf);
  } catch (_) {
    return new Map();
  }
}

// The slicer's printer model string ("MK4S", "COREONE", "Bambu Lab X1 Carbon"),
// or null.
function readPrinterModelName(filename, buf) {
  return readMetadataMap(filename, buf).get('printer_model') || null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Maps a slicer's printer model string onto this farm's printer_models
// registry rows ({ model_id, label }): an exact normalized match on model_id or
// label first ("MK4S" = mk4s, "COREONE" = "Core One"), then a label contained
// in the slicer string ("Bambu Lab X1 Carbon" contains "X1 Carbon"). The
// longest such label wins so "MK4S" is never mistaken for "MK4". Null when
// nothing matches.
function matchRegistryModel(slicerModel, models) {
  const s = norm(slicerModel);
  if (!s) return null;
  const exact = models.find(m => norm(m.model_id) === s || norm(m.label) === s);
  if (exact) return exact.model_id;
  const contained = models
    .filter(m => [norm(m.label), norm(m.model_id)].some(t => t.length >= 2 && s.includes(t)))
    .sort((a, b) => Math.max(norm(b.label).length, norm(b.model_id).length) - Math.max(norm(a.label).length, norm(a.model_id).length));
  return contained[0]?.model_id || null;
}

module.exports = { readMetadataMap, readPrinterModelName, matchRegistryModel, parseCommentLines };
