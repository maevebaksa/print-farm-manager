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
//   ideaMaker ";Key: value" lines: ";Print Time: <seconds>", ";Material#N Used:
//            <mm>" in the footer, ";Filament Diameter #N:", ";Filament Density
//            #N:" (kg/m3) and ";Filament Type #N:" in the header.
//
// Print time and filament rules follow Moonraker's metadata parser
// (moonraker/components/file_manager/metadata.py: PrusaSlicer, BambuStudio,
// IdeaMaker classes) and the writers in OrcaSlicer's own source
// (GCodeProcessor.cpp's "estimated printing time (normal mode)" and, for Bambu
// profiles, "model printing time: X; total estimated time: Y"; GCode.cpp's
// "total filament used [g]"; the Bambu-style header's "total filament weight
// [g] :"). Times are written as "%dd %dh %dm %ds" (Orca Utils.hpp get_time_dhms,
// the same form PrusaSlicer uses).
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

// Head + tail text of any supported file, as "; key = value"-style comment
// lines, for the regex rules in readPrintStats. .bgcode metadata pairs are
// rendered back into that same line form so one rule set covers every format.
function readHeaderText(filename, buf) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.bgcode')) {
    const meta = readBgcodeMetadata(buf);
    return [...meta.printer, ...meta.print, ...meta.file, ...meta.slicer].map(([k, v]) => `; ${k} = ${v}`).join('\n');
  }
  const gcode = lower.endsWith('.3mf') ? threeMfToGcode(buf) : buf;
  if (gcode.length <= HEAD_BYTES + TAIL_BYTES) return gcode.toString('latin1');
  return gcode.subarray(0, HEAD_BYTES).toString('latin1') + '\n' + gcode.subarray(gcode.length - TAIL_BYTES).toString('latin1');
}

// "1d 2h 3m 4s" / "2h 5m" / "41s" (days/hours/minutes/seconds, any subset).
function parseDhms(s) {
  if (!s) return null;
  let total = 0, found = false;
  for (const [re, mult] of [[/(\d+)\s*d/, 86400], [/(\d+)\s*h/, 3600], [/(\d+)\s*m(?!s)/, 60], [/(\d+(?:\.\d+)?)\s*s/, 1]]) {
    const m = s.match(re);
    if (m) { total += parseFloat(m[1]) * mult; found = true; }
  }
  return found ? Math.round(total) : null;
}

const FLOAT = '([0-9]+(?:\\.[0-9]+)?)';
const floats = (str) => (str.match(/[0-9]+(?:\.[0-9]+)?/g) || []).map(Number);

// { est_print_secs, material_grams, material_type } from the file's own
// metadata, each null when the file does not say. Never throws.
function readPrintStats(filename, buf) {
  const out = { est_print_secs: null, material_grams: null, material_type: null };
  let text;
  try { text = readHeaderText(filename, buf); } catch (_) { return out; }
  const line = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };

  // Print time: Bambu-profile Orca/BambuStudio total, then PrusaSlicer/Orca
  // normal mode, then ideaMaker's seconds.
  out.est_print_secs =
    parseDhms(line(/total estimated time:\s*([^;\n]+)/i)) ??
    parseDhms(line(/estimated printing time \(normal mode\)\s*=\s*([^\n]+)/i)) ??
    (() => { const v = line(new RegExp(';Print Time:\\s*' + FLOAT, 'i')); return v ? Math.round(parseFloat(v)) : null; })();

  // Filament weight in grams: the slicer's total, then the Bambu-style header
  // total, then the per-extruder list summed, then ideaMaker's length computed
  // into grams exactly as Moonraker does (pi/4 * d^2 * length * density / 1e6,
  // density in kg/m3).
  const total = line(new RegExp('total filament used \\[g\\]\\s*=\\s*' + FLOAT, 'i'))
    ?? line(new RegExp('total filament weight \\[g\\]\\s*:\\s*' + FLOAT, 'i'));
  if (total != null) {
    out.material_grams = parseFloat(total);
  } else {
    const perExtruder = line(/;\s*filament used \[g\]\s*=\s*([^\n]+)/i);
    if (perExtruder) {
      const sum = floats(perExtruder).reduce((a, b) => a + b, 0);
      if (sum > 0) out.material_grams = sum;
    } else {
      const lengths = [...text.matchAll(/;Material.\d\sUsed:\s+([0-9.]+)/gi)].map(m => parseFloat(m[1]));
      const diameters = [...text.matchAll(/;Filament\sDiameter\s.\d:\s+([0-9.]+)/gi)].map(m => parseFloat(m[1]));
      const densities = [...text.matchAll(/;Filament\sDensity\s.\d:\s+([0-9.]+)/gi)].map(m => parseFloat(m[1]));
      if (lengths.length && lengths.length === diameters.length && lengths.length === densities.length) {
        out.material_grams = lengths.reduce((g, len, i) => g + (Math.PI / 4) * diameters[i] ** 2 * len * densities[i] / 1e6, 0);
      }
    }
  }
  if (out.material_grams != null) out.material_grams = Math.round(out.material_grams * 100) / 100;

  // Filament type: PrusaSlicer/Orca "filament_type = PLA;PETG" (one per
  // extruder), else ideaMaker's "Filament Type #1: PLA". Distinct values,
  // comma-joined; empty entries dropped.
  const types = line(/;\s*filament_type\s*=\s*([^\n]+)/i)
    ?? line(/;Filament\sType\s.\d:\s*([^\n]+)/i)
    ?? line(/;Filament\stype\s=\s*([^\n]+)/i);
  if (types) {
    const list = [...new Set(types.split(/[;,]/).map(t => t.trim().replace(/^"|"$/g, '')).filter(Boolean))];
    if (list.length) out.material_type = list.join(', ');
  }
  return out;
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

module.exports = { readMetadataMap, readPrinterModelName, matchRegistryModel, parseCommentLines, readPrintStats, parseDhms };
