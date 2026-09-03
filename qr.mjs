// A QR code encoder, for the moment at the end of install.sh where the URL
// has to get from this terminal onto a phone. Byte mode, error-correction
// level M, versions 1 to 10 (up to 213 bytes), written from ISO/IEC 18004 so
// the runtime dependency count stays at three. server.mjs never imports it;
// nothing here is served.
//
//   node qr.mjs [--color] [--indent N] TEXT
//
// draws the code with half-block characters, two modules per character cell,
// four modules of quiet zone around it. Without --color the light modules are
// the terminal's foreground, which is right on a dark theme and inverted on a
// light one (phone cameras read both). With --color the colours are explicit,
// white on black, and the code scans the same everywhere.

import { pathToFileURL } from 'node:url';

const MAX_VERSION = 10;
// Level M, indexed by version: error-correction codewords per block, and how
// many blocks the data is split into.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

// --- Reed-Solomon over GF(2^8), reducing polynomial x^8+x^4+x^3+x^2+1 -------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// Coefficients of the monic generator polynomial of the given degree, highest
// power first, the leading 1 left off.
function rsGenerator(degree) {
  const g = new Array(degree).fill(0);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = gfMul(g[j], root) ^ (j + 1 < degree ? g[j + 1] : 0);
    }
    root = gfMul(root, 2);
  }
  return g;
}

/** The `degree` error-correction codewords for one block of data codewords. */
export function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(gen[i], factor);
  }
  return result;
}

// --- capacity ---------------------------------------------------------------

// Modules left for data once the finder, timing, alignment, format and
// version patterns are placed.
function rawDataModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

const totalCodewords = (version) => Math.floor(rawDataModules(version) / 8);
const dataCodewords = (version) =>
  totalCodewords(version) - ECC_PER_BLOCK[version] * BLOCKS[version];
const lengthBits = (version) => (version >= 10 ? 16 : 8);

/** Longest byte string this encoder will accept. */
export const MAX_BYTES = Math.floor(
  (8 * dataCodewords(MAX_VERSION) - 4 - lengthBits(MAX_VERSION)) / 8,
);

// Centres of the alignment patterns along one axis.
function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

// --- format and version information ----------------------------------------

// 15 bits: level M (00), the mask, BCH remainder, XORed with the fixed mask.
function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// 18 bits: the version number and its BCH remainder. Versions 7 and up only.
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// --- masks ------------------------------------------------------------------

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The standard's four penalty rules. Lower is easier for a camera to read.
function penalty(modules) {
  const n = modules.length;
  let score = 0;
  const finderLike = [true, false, true, true, true, false, true];
  const scoreLine = (at) => {
    let run = 0;
    let prev = null;
    for (let i = 0; i < n; i++) {
      const dark = at(i);
      if (dark === prev) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        prev = dark;
        run = 1;
      }
      if (i + 7 <= n && finderLike.every((d, k) => at(i + k) === d)) {
        const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !at(i - k));
        const lightAfter = i + 11 <= n && [7, 8, 9, 10].every((k) => !at(i + k));
        if (lightBefore) score += 40;
        if (lightAfter) score += 40;
      }
    }
  };
  for (let y = 0; y < n; y++) scoreLine((x) => modules[y][x]);
  for (let x = 0; x < n; x++) scoreLine((y) => modules[y][x]);
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const a = modules[y][x];
      if (a === modules[y][x + 1] && a === modules[y + 1][x] && a === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }
  let dark = 0;
  for (const row of modules) for (const d of row) if (d) dark++;
  const percent = (dark * 100) / (n * n);
  const below = Math.floor(percent / 5) * 5;
  score += (Math.min(Math.abs(below - 50), Math.abs(below + 5 - 50)) / 5) * 10;
  return score;
}

// --- the encoder ------------------------------------------------------------

/**
 * Encode `text` (UTF-8) and return the module matrix: an array of rows, each
 * an array of booleans, true for dark. Throws a RangeError when the text is
 * longer than MAX_BYTES.
 */
export function encode(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = 1;
  const fits = (v) => 4 + lengthBits(v) + 8 * bytes.length <= 8 * dataCodewords(v);
  while (version <= MAX_VERSION && !fits(version)) version++;
  if (version > MAX_VERSION) {
    throw new RangeError(
      `text is ${bytes.length} bytes; a QR code here holds at most ${MAX_BYTES}`,
    );
  }

  // Bit stream: mode, length, the bytes, terminator, pad to a byte, pad bytes.
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, lengthBits(version));
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = new Array(capacity / 8).fill(0);
  bits.forEach((bit, i) => (data[i >>> 3] |= bit << (7 - (i & 7))));

  // Split into blocks, append error correction, interleave.
  const numBlocks = BLOCKS[version];
  const ecc = ECC_PER_BLOCK[version];
  const total = totalCodewords(version);
  const shortBlocks = numBlocks - (total % numBlocks);
  const shortLength = Math.floor(total / numBlocks) - ecc;
  const blocks = [];
  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: chunk, ecc: rsRemainder(chunk, ecc) });
  }
  const codewords = [];
  for (let i = 0; i <= shortLength; i++) {
    for (const block of blocks) if (i < block.data.length) codewords.push(block.data[i]);
  }
  for (let i = 0; i < ecc; i++) for (const block of blocks) codewords.push(block.ecc[i]);

  // Function patterns. `reserved` marks every module the data must step over.
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, ring !== 2 && ring !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((cx, i) => {
    positions.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  if (version >= 7) {
    const vbits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  const drawFormat = (mask) => {
    const fbits = formatBits(mask);
    const bit = (i) => ((fbits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);

  // Codewords snake up and down in two-module columns from the right; the
  // vertical timing column is skipped whole.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y][x] || bitIndex >= codewords.length * 8) continue;
        modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex++;
      }
    }
  }

  // Try every mask on the data modules, keep the one a camera likes best.
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(modules);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return modules;
}

// --- terminal rendering -----------------------------------------------------

/**
 * Draw a module matrix as text, two module rows per line. With `color` the
 * light modules are painted bright white on black explicitly; otherwise they
 * are plain block characters in the terminal's own colours.
 */
export function render(modules, { color = false, indent = 0, quiet = 4 } = {}) {
  const n = modules.length;
  const width = n + quiet * 2;
  const dark = (x, y) => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < n && my < n && modules[my][mx];
  };
  const lines = [];
  for (let y = 0; y < width; y += 2) {
    let line = ' '.repeat(indent) + (color ? '\x1b[40;97m' : '');
    for (let x = 0; x < width; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top ? (bottom ? ' ' : '▄') : bottom ? '▀' : '█';
    }
    lines.push(line + (color ? '\x1b[0m' : ''));
  }
  return lines.join('\n') + '\n';
}

// --- command line -----------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let color = false;
  let indent = 0;
  let text;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--color') color = true;
    else if (args[i] === '--indent') indent = Number(args[++i]) || 0;
    else text = args[i];
  }
  if (text === undefined) {
    process.stderr.write('usage: node qr.mjs [--color] [--indent N] TEXT\n');
    process.exit(2);
  }
  try {
    process.stdout.write(render(encode(text), { color, indent }));
  } catch (err) {
    process.stderr.write(`qr.mjs: ${err.message}\n`);
    process.exit(1);
  }
}
