// Unit tests for server/gcode-convert.js (.bgcode and sliced .3mf to plain G-code).
// Fixtures are built byte by byte from the format specs (see support/gcode-fixtures.js).
// The decoders were also checked byte-exact against libbgcode's own reference
// conversions (tests/data/mini_cube_b and mini_cube_ps2.8.1 in prusa3d/libbgcode),
// which are not vendored here.

const zlib = require('zlib');
const { toPlainGcode, bgcodeToGcode, threeMfToGcode, heatshrinkDecode, meatpackDecode } = require('../gcode-convert');
const { buildBgcode, buildZip } = require('./support/gcode-fixtures');

// Heatshrink bitstream writer: literals are a 1 tag bit + 8 bits, back-references
// a 0 tag bit + (offset - 1) in windowBits + (count - 1) in lookaheadBits, MSB first.
function heatshrinkEncode(ops, windowBits = 12, lookaheadBits = 4) {
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  for (const op of ops) {
    if (typeof op === 'string') {
      for (const ch of op) { push(1, 1); push(ch.charCodeAt(0), 8); }
    } else {
      push(0, 1); push(op.offset - 1, windowBits); push(op.count - 1, lookaheadBits);
    }
  }
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}

const MP = { ENABLE: [0xff, 0xff, 251], NO_SPACES: [0xff, 0xff, 247] };

describe('heatshrinkDecode', () => {
  test('decodes literals and a self-overlapping back-reference (12/4)', () => {
    const src = heatshrinkEncode(['abc', { offset: 3, count: 6 }]);
    expect(heatshrinkDecode(src, 12, 4, 9).toString()).toBe('abcabcabc');
  });

  test('decodes with the 11/4 window', () => {
    const src = heatshrinkEncode(['xy', { offset: 2, count: 4 }], 11, 4);
    expect(heatshrinkDecode(src, 11, 4, 6).toString()).toBe('xyxyxy');
  });

  test('throws when the data ends before the declared size', () => {
    expect(() => heatshrinkDecode(heatshrinkEncode(['ab']), 12, 4, 10)).toThrow(/ended early/);
  });
});

describe('meatpackDecode', () => {
  test('unpacks packed pairs and re-inserts spaces on G lines (no-spaces mode)', () => {
    // "G1X10\n" packed: (G,1)=0x1D (X,1)=0x1E (0,\n)=0xC0
    const src = Buffer.from([...MP.ENABLE, ...MP.NO_SPACES, 0x1d, 0x1e, 0xc0]);
    expect(meatpackDecode(src).toString()).toBe('G1 X10\n');
  });

  test('handles a full-width character following a packed one', () => {
    // "G1Y1\n": (G,1)=0x1D, (Y unpacked, 1 packed)=0x1F + 'Y', (\n,\n)=0xCC
    const src = Buffer.from([...MP.ENABLE, ...MP.NO_SPACES, 0x1d, 0x1f, 0x59, 0xcc]);
    expect(meatpackDecode(src).toString()).toBe('G1 Y1\n');
  });

  test('passes bytes through unchanged while packing is disabled (comment lines)', () => {
    expect(meatpackDecode(Buffer.from('; a comment\n')).toString()).toBe('; a comment\n');
  });
});

describe('bgcodeToGcode', () => {
  const printerMeta = { type: 3, data: Buffer.from('printer_model=MK4S\nnozzle_diameter=0.4\n') };
  const printMeta = { type: 4, data: Buffer.from('estimated printing time (normal mode)=1h 2m\n') };

  test('decodes an uncompressed, unencoded G-code block and writes metadata as comments', () => {
    const buf = buildBgcode([
      printerMeta,
      printMeta,
      { type: 1, data: Buffer.from('G28\n\n;\nG1 X1 Y2\n') },
    ]);
    const text = bgcodeToGcode(buf).toString();
    expect(text).toContain('; printer_model = MK4S\n; nozzle_diameter = 0.4\n');
    expect(text).toContain('\nG28\nG1 X1 Y2\n'); // blank and empty-comment lines dropped
    expect(text).toContain('; estimated printing time (normal mode) = 1h 2m\n');
    expect(text.indexOf('G28')).toBeLessThan(text.indexOf('estimated printing time'));
  });

  test('decodes zlib-wrapped Deflate blocks', () => {
    const gcode = Buffer.from('G28\nG1 X5\n');
    const buf = buildBgcode([
      printerMeta,
      { type: 1, compression: 1, data: gcode, compressedData: zlib.deflateSync(gcode) },
    ]);
    expect(bgcodeToGcode(buf).toString()).toContain('G28\nG1 X5\n');
  });

  test('decodes PrusaSlicer\'s default Heatshrink 12/4 + MeatPack G-code blocks', () => {
    const packed = Buffer.from([...MP.ENABLE, ...MP.NO_SPACES, 0x1d, 0x1e, 0xc0]); // "G1X10\n"
    const compressed = heatshrinkEncode([packed.toString('latin1')]);
    const buf = buildBgcode([
      printerMeta,
      { type: 1, compression: 3, encoding: 2, data: packed, compressedData: compressed },
    ], { checksumType: 1 });
    expect(bgcodeToGcode(buf).toString()).toContain('\nG1 X10\n');
  });

  test('throws on a file that is not bgcode', () => {
    expect(() => bgcodeToGcode(Buffer.from('G28\n'))).toThrow(/not a \.bgcode/);
  });

  test('throws when there is no G-code block', () => {
    expect(() => bgcodeToGcode(buildBgcode([printerMeta]))).toThrow(/no G-code/);
  });
});

describe('threeMfToGcode', () => {
  test('extracts plate 1 G-code from a sliced .3mf', () => {
    const buf = buildZip([
      { name: '3D/3dmodel.model', data: Buffer.from('<model/>') },
      { name: 'Metadata/plate_2.gcode', data: Buffer.from('; plate 2\n') },
      { name: 'Metadata/plate_1.gcode', data: Buffer.from('; plate 1\nG28\n'), method: 8 },
    ]);
    expect(threeMfToGcode(buf).toString()).toBe('; plate 1\nG28\n');
  });

  test('uses the only plate when a single-plate export is not plate 1', () => {
    const buf = buildZip([{ name: 'Metadata/plate_3.gcode', data: Buffer.from('G28\n') }]);
    expect(threeMfToGcode(buf).toString()).toBe('G28\n');
  });

  test('rejects several plates without a plate 1 instead of guessing', () => {
    const buf = buildZip([
      { name: 'Metadata/plate_2.gcode', data: Buffer.from('G28\n') },
      { name: 'Metadata/plate_3.gcode', data: Buffer.from('G28\n') },
    ]);
    expect(() => threeMfToGcode(buf)).toThrow(/2 plates/);
  });

  test('rejects an unsliced model .3mf', () => {
    const buf = buildZip([{ name: '3D/3dmodel.model', data: Buffer.from('<model/>') }]);
    expect(() => threeMfToGcode(buf)).toThrow(/no sliced G-code/);
  });
});

describe('toPlainGcode', () => {
  test('returns null for plain G-code', () => {
    expect(toPlainGcode('part.gcode', Buffer.from('G28\n'))).toBeNull();
  });

  test('renames .bgcode and .gcode.3mf outputs to .gcode', () => {
    const bg = buildBgcode([{ type: 1, data: Buffer.from('G28\n') }]);
    expect(toPlainGcode('3x part_0.4n.bgcode', bg).filename).toBe('3x part_0.4n.gcode');
    const zip = buildZip([{ name: 'Metadata/plate_1.gcode', data: Buffer.from('G28\n') }]);
    expect(toPlainGcode('part.gcode.3mf', zip).filename).toBe('part.gcode');
    expect(toPlainGcode('part.3mf', zip).filename).toBe('part.gcode');
  });
});
