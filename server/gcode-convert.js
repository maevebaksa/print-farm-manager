// Converts a sliced file the farm accepts (.bgcode, sliced .3mf) into plain
// ASCII G-code, for connectors whose printer software only accepts plain
// G-code (OctoPrint: .gcode/.gco/.g only, per octoprint/filemanager).
// Dependency-free, ported from the formats' own reference sources, never guessed:
//
//   .bgcode  Prusa's binary G-code container.
//            Container:  https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md
//            Conversion: libbgcode src/LibBGCode/convert/convert.cpp (from_binary_to_ascii),
//                        whose output this mirrors line for line.
//            MeatPack:   libbgcode src/LibBGCode/binarize/meatpack.cpp (unbinarize)
//            Heatshrink: https://github.com/atomicobject/heatshrink v0.4.1
//                        (heatshrink_decoder.c, the version libbgcode pins)
//            Deflate blocks are zlib-wrapped (libbgcode uses inflateInit), not raw.
//
//   .3mf     A sliced Bambu Studio / OrcaSlicer project ("Export plate sliced
//            file", usually named .gcode.3mf) stores each plate's G-code as a
//            ZIP entry "Metadata/plate_<N>.gcode" (OrcaSlicer
//            src/libslic3r/Format/bbs_3mf.cpp, _add_gcode_file_to_archive).
//            An unsliced model .3mf has no G-code at all and cannot be printed
//            without a slicer: that is rejected with a clear error.
const zlib = require('zlib');
const { readZipEntries, readZipEntryData } = require('./gcode-thumbnail');

// ─── .bgcode ─────────────────────────────────────────────────────────────────

const BLOCK = { FILE_META: 0, GCODE: 1, SLICER_META: 2, PRINTER_META: 3, PRINT_META: 4, THUMBNAIL: 5 };
const COMPRESSION = { NONE: 0, DEFLATE: 1, HEATSHRINK_11_4: 2, HEATSHRINK_12_4: 3 };
const GCODE_ENCODING = { NONE: 0, MEATPACK: 1, MEATPACK_COMMENTS: 2 };
const METADATA_ENCODING = { INI: 0, JSON: 1 };

// Heatshrink LZSS decoder. Equivalent to heatshrink_decoder.c's sink/poll
// state machine run over a fully-available input: a 1 tag bit selects a literal
// (8 bits) or a back-reference (window_sz2 index bits, lookahead_sz2 count
// bits, both stored minus one), read MSB first. The decoder's window starts
// zero-filled (heatshrink_decoder_reset memsets it), so a reference reaching
// before the start of output yields 0 bytes. Stops at the block's declared
// uncompressed size, exactly where libbgcode stops polling.
function heatshrinkDecode(src, windowBits, lookaheadBits, outSize) {
  const out = Buffer.alloc(outSize);
  const totalBits = src.length * 8;
  let bitPos = 0;
  let o = 0;
  const bits = (n) => {
    if (bitPos + n > totalBits) return -1;
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((src[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  while (o < outSize) {
    const tag = bits(1);
    if (tag < 0) break;
    if (tag === 1) {
      const b = bits(8);
      if (b < 0) break;
      out[o++] = b;
    } else {
      const index = bits(windowBits);
      if (index < 0) break;
      const count = bits(lookaheadBits);
      if (count < 0) break;
      const offset = index + 1;
      for (let i = 0; i <= count && o < outSize; i++, o++) {
        out[o] = o - offset >= 0 ? out[o - offset] : 0;
      }
    }
  }
  if (o !== outSize) throw new Error(`heatshrink data ended early (${o} of ${outSize} bytes)`);
  return out;
}

function decompress(data, compression, uncompressedSize) {
  switch (compression) {
    case COMPRESSION.NONE: return data;
    case COMPRESSION.DEFLATE: return zlib.inflateSync(data);
    case COMPRESSION.HEATSHRINK_11_4: return heatshrinkDecode(data, 11, 4, uncompressedSize);
    case COMPRESSION.HEATSHRINK_12_4: return heatshrinkDecode(data, 12, 4, uncompressedSize);
    default: throw new Error(`unknown bgcode compression type ${compression}`);
  }
}

// MeatPack decoder, a direct port of libbgcode's MeatPack::unbinarize,
// including its post-processing: a space is re-inserted before each parameter
// letter on a G line (the "no spaces" packing mode strips them) and repeated
// newlines are collapsed.
const MP_SIGNAL = 0xff;
const MP_ENABLE_PACKING = 251;
const MP_DISABLE_PACKING = 250;
const MP_RESET_ALL = 249;
const MP_ENABLE_NO_SPACES = 247;
const MP_DISABLE_NO_SPACES = 246;
const MP_CHARS = '0123456789. \nGX';
const NL = 0x0a;
const SPACE = 0x20;
const G_LINE_PARAMS = new Set('XYZEFIJRSGPWHCA'.split('').map(c => c.charCodeAt(0)));

function meatpackDecode(src) {
  let unbinarizing = false;
  let noSpaces = false;
  let cmdActive = false;
  let cmdCount = 0;
  let charBuf = 0;
  let fullCharQueue = 0;
  const pending = [];

  const getChar = (nibble) => {
    if (nibble === 0b1011) return noSpaces ? 0x45 /* 'E' */ : SPACE;
    return nibble < 15 ? MP_CHARS.charCodeAt(nibble) : 0;
  };

  const handleCommand = (c) => {
    if (c === MP_ENABLE_PACKING) unbinarizing = true;
    else if (c === MP_DISABLE_PACKING || c === MP_RESET_ALL) unbinarizing = false;
    else if (c === MP_ENABLE_NO_SPACES) noSpaces = true;
    else if (c === MP_DISABLE_NO_SPACES) noSpaces = false;
  };

  const handleRxChar = (c) => {
    if (!unbinarizing) { pending.push(c); return; }
    if (fullCharQueue > 0) {
      pending.push(c);
      if (charBuf > 0) { pending.push(charBuf); charBuf = 0; }
      fullCharQueue--;
      return;
    }
    const firstNotPacked = (c & 0x0f) === 0x0f;
    const secondNotPacked = (c & 0xf0) === 0xf0;
    const first = firstNotPacked ? 0 : getChar(c & 0x0f);
    const second = secondNotPacked ? 0 : getChar((c >> 4) & 0x0f);
    if (firstNotPacked) {
      fullCharQueue++;
      if (secondNotPacked) fullCharQueue++;
      else charBuf = second;
    } else {
      pending.push(first);
      if (first !== NL) {
        if (secondNotPacked) fullCharQueue++;
        else pending.push(second);
      }
    }
  };

  let out = Buffer.alloc(Math.max(64, src.length * 2));
  let len = 0;
  let addSpace = false;
  const put = (b) => {
    if (len === out.length) {
      const bigger = Buffer.alloc(out.length * 2);
      out.copy(bigger, 0, 0, len);
      out = bigger;
    }
    out[len++] = b;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === MP_SIGNAL) {
      if (cmdCount > 0) { cmdActive = true; cmdCount = 0; } else cmdCount++;
    } else if (cmdActive) {
      handleCommand(c);
      cmdActive = false;
    } else {
      if (cmdCount > 0) { handleRxChar(MP_SIGNAL); cmdCount = 0; }
      handleRxChar(c);
    }

    for (const ch of pending) {
      let newLine = false;
      if (ch === 0x47 /* 'G' */ && (len === 0 || out[len - 1] === NL)) {
        addSpace = true;
        newLine = true;
      } else if (ch === NL) {
        addSpace = false;
      }
      if (!newLine && addSpace && (len === 0 || out[len - 1] !== SPACE) && G_LINE_PARAMS.has(ch)) put(SPACE);
      if (ch !== NL || len === 0 || out[len - 1] !== NL) put(ch);
    }
    pending.length = 0;
  }
  return out.subarray(0, len);
}

function decodeGcode(data, encoding) {
  if (encoding === GCODE_ENCODING.NONE) return data;
  if (encoding === GCODE_ENCODING.MEATPACK || encoding === GCODE_ENCODING.MEATPACK_COMMENTS) return meatpackDecode(data);
  throw new Error(`unknown bgcode G-code encoding ${encoding}`);
}

// INI metadata: "key=value" lines, split on the first '='.
function decodeIni(data) {
  const pairs = [];
  for (const line of data.toString('utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq !== -1) pairs.push([line.slice(0, eq), line.slice(eq + 1)]);
  }
  return pairs;
}

// convert.cpp's remove_empty_lines: drop lines that are blank or an empty
// comment once trimmed, keep every other line verbatim.
function removeEmptyLines(text) {
  let ret = '';
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    let reduced = line.replace(/^[ \t]+|[ \t]+$/g, '');
    if (reduced.startsWith(';')) reduced = reduced.slice(1).replace(/^[ \t]+|[ \t]+$/g, '');
    if (reduced !== '') ret += line + '\n';
  }
  return ret;
}

function readBlocks(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 4) !== 'GCDE') throw new Error('not a .bgcode file (bad magic)');
  const checksumSize = buf.readUInt16LE(8) === 0 ? 0 : 4;
  const blocks = [];
  let offset = 10;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new Error('truncated .bgcode block header');
    const type = buf.readUInt16LE(offset);
    const compression = buf.readUInt16LE(offset + 2);
    const uncompressedSize = buf.readUInt32LE(offset + 4);
    let headerSize = 8;
    let dataSize = uncompressedSize;
    if (compression !== COMPRESSION.NONE) {
      dataSize = buf.readUInt32LE(offset + 8);
      headerSize = 12;
    }
    const paramsOffset = offset + headerSize;
    const paramsSize = type === BLOCK.THUMBNAIL ? 6 : 2;
    const dataOffset = paramsOffset + paramsSize;
    if (dataOffset + dataSize > buf.length) throw new Error('truncated .bgcode block data');
    const raw = buf.subarray(dataOffset, dataOffset + dataSize);
    const block = { type, params: buf.subarray(paramsOffset, dataOffset) };
    if (type !== BLOCK.THUMBNAIL) block.encoding = block.params.readUInt16LE(0);
    block.data = decompress(raw, compression, uncompressedSize);
    if (block.data.length !== uncompressedSize) throw new Error('corrupt .bgcode block (size mismatch)');
    blocks.push(block);
    offset = dataOffset + dataSize + checksumSize;
  }
  return blocks;
}

// Returns the plain-text equivalent of a .bgcode file as a Buffer, laid out
// the same way libbgcode's from_binary_to_ascii writes it: file/printer
// metadata comments, thumbnails as base64 comments, the G-code, then print
// and slicer metadata comments. Throws on a malformed file.
function bgcodeToGcode(buf) {
  const blocks = readBlocks(buf);
  // Metadata was decoded as UTF-8 and is re-encoded as UTF-8; G-code text is
  // handled as latin1 (pushGcode) so every byte round-trips unchanged.
  const out = [];
  const pushText = (s) => out.push(Buffer.from(s, 'utf8'));
  const pushGcode = (s) => out.push(Buffer.from(s, 'latin1'));
  const writeMetadata = (pairs) => { for (const [k, v] of pairs) pushText(`; ${k} = ${v}\n`); };

  const fileMeta = blocks.find(b => b.type === BLOCK.FILE_META);
  if (fileMeta) {
    const pairs = decodeIni(fileMeta.data);
    const get = (key) => pairs.find(([k]) => k === key)?.[1];
    let producer = get('Producer') ?? 'Unknown';
    if (get('Produced on') !== undefined) producer += ' on ' + get('Produced on');
    if (get('Prepared by') !== undefined) producer += '\n; prepared by ' + get('Prepared by');
    pushText(`; generated by ${producer}\n\n\n`);
  }

  const printerMeta = blocks.find(b => b.type === BLOCK.PRINTER_META);
  if (printerMeta) writeMetadata(decodeIni(printerMeta.data));

  const THUMB_FORMAT = { 0: 'thumbnail', 1: 'thumbnail_JPG', 2: 'thumbnail_QOI' };
  for (const b of blocks.filter(x => x.type === BLOCK.THUMBNAIL)) {
    const format = THUMB_FORMAT[b.params.readUInt16LE(0)] || 'thumbnail';
    const width = b.params.readUInt16LE(2);
    const height = b.params.readUInt16LE(4);
    let encoded = b.data.toString('base64');
    pushText(`\n;\n; ${format} begin ${width}x${height} ${encoded.length}\n`);
    while (encoded.length > 78) { pushText(`; ${encoded.slice(0, 78)}\n`); encoded = encoded.slice(78); }
    if (encoded.length > 0) pushText(`; ${encoded}\n`);
    pushText(`; ${format} end\n;\n`);
  }

  pushText('\n');
  const gcodeBlocks = blocks.filter(b => b.type === BLOCK.GCODE);
  if (gcodeBlocks.length === 0) throw new Error('.bgcode file contains no G-code');
  for (const b of gcodeBlocks) {
    const text = removeEmptyLines(decodeGcode(b.data, b.encoding).toString('latin1'));
    if (text) pushGcode(text);
  }

  const printMeta = blocks.find(b => b.type === BLOCK.PRINT_META);
  if (printMeta) {
    pushText('\n');
    writeMetadata(decodeIni(printMeta.data));
  }

  const slicerBlocks = blocks.filter(b => b.type === BLOCK.SLICER_META);
  const jsonBlock = slicerBlocks.find(b => b.encoding === METADATA_ENCODING.JSON);
  const iniBlock = slicerBlocks.find(b => b.encoding === METADATA_ENCODING.INI);
  if (jsonBlock) {
    pushText('\n; prusaslicer_json_config = begin\n');
    pushText(`; ${jsonBlock.data.toString('utf8')}\n`);
    pushText('; prusaslicer_json_config = end\n');
  }
  if (iniBlock) {
    pushText('\n; prusaslicer_config = begin\n');
    writeMetadata(decodeIni(iniBlock.data));
    pushText('; prusaslicer_config = end\n\n');
  }

  return Buffer.concat(out);
}

// ─── .3mf (sliced) ───────────────────────────────────────────────────────────

const PLATE_GCODE = /^Metadata\/plate_(\d+)\.gcode$/i;

// Returns the G-code for a sliced .3mf. Prefers plate 1 (the plate the Bambu
// driver prints, and what a single-plate export contains); a file holding
// exactly one plate's G-code under another number uses that one. Several
// plates with no plate 1, or no G-code at all, is ambiguous or unprintable
// and throws rather than guessing.
function threeMfToGcode(buf) {
  const entries = readZipEntries(buf);
  if (entries.length === 0) throw new Error('not a readable .3mf (ZIP) file');
  const plates = entries.filter(e => PLATE_GCODE.test(e.name));
  if (plates.length === 0) {
    throw new Error('this .3mf contains no sliced G-code: export it from OrcaSlicer or Bambu Studio with "Export plate sliced file" (.gcode.3mf), or upload a .gcode');
  }
  const entry = plates.find(e => PLATE_GCODE.exec(e.name)[1] === '1') || (plates.length === 1 ? plates[0] : null);
  if (!entry) {
    throw new Error(`this .3mf holds G-code for ${plates.length} plates and none is plate 1: export the single plate to print`);
  }
  const data = readZipEntryData(buf, entry);
  if (!data) throw new Error(`could not extract ${entry.name} from the .3mf (unsupported ZIP compression)`);
  return data;
}

// ─── Dispatch by extension ───────────────────────────────────────────────────

// Returns { buffer, filename } with plain G-code and a .gcode filename for a
// .bgcode or .3mf input, or null when the file is already plain G-code (the
// caller uploads it untouched). Throws when conversion is impossible.
function toPlainGcode(filename, buf) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.bgcode')) {
    return { buffer: bgcodeToGcode(buf), filename: filename.slice(0, -'.bgcode'.length) + '.gcode' };
  }
  if (lower.endsWith('.3mf')) {
    const base = lower.endsWith('.gcode.3mf') ? filename.slice(0, -'.gcode.3mf'.length) : filename.slice(0, -'.3mf'.length);
    return { buffer: threeMfToGcode(buf), filename: base + '.gcode' };
  }
  return null;
}

module.exports = { toPlainGcode, bgcodeToGcode, threeMfToGcode, heatshrinkDecode, meatpackDecode };
