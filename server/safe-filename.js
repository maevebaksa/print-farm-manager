// Client-supplied upload filenames (multer's file.originalname) are never
// trusted as paths: a name like "../../server/index.js", or with backslashes
// on the Windows farm machine, would otherwise let an upload write outside
// server/gcode/. Two helpers, for the two places a name is used:
//
//   safeFilename     the name written to disk: bare basename, only
//                    [A-Za-z0-9_ .-()+], no leading dots.
//   displayFilename  the name stored for display (gcodes.filename): bare
//                    basename with control characters removed, but otherwise
//                    unchanged, so "Ünterteil.gcode" still reads correctly.
//
// Both split on "/" and "\" explicitly rather than using path.basename, whose
// behavior differs between POSIX and Windows.

function lastSegment(original) {
  return String(original ?? '').split(/[\\/]/).pop();
}

function safeFilename(original) {
  const cleaned = lastSegment(original).replace(/[^\w.\- ()+]/g, '_').replace(/^\.+/, '');
  return cleaned || 'upload.gcode';
}

function displayFilename(original) {
  // eslint-disable-next-line no-control-regex
  const cleaned = lastSegment(original).replace(/[\x00-\x1f\x7f]/g, '').trim().replace(/^\.+/, '');
  return cleaned || 'upload.gcode';
}

module.exports = { safeFilename, displayFilename };
