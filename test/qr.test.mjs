// qr.mjs, the code install.sh prints for the phone to scan.
//
// The encoder was checked once against an independent decoder (jsQR) at every
// version from 1 to 10, including the multi-block ones. That decoder is not a
// dependency, so what stays here is: the standard's own worked example for
// the error correction, a golden matrix from that verified run, and the
// structural rules a camera relies on, checked at every version.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, render, rsRemainder, MAX_BYTES } from '../qr.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Level M data capacity, minus the mode and length header, per version: a
// text this long lands on exactly that version.
const FILL = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

const rows = (matrix) => matrix.map((row) => row.map((d) => (d ? '#' : '.')).join(''));

test('reed-solomon matches the worked example in ISO/IEC 18004', () => {
  // "HELLO WORLD" at version 1-M: 16 data codewords, 10 for error correction.
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('a tailnet URL encodes to the matrix an independent decoder read back', () => {
  const matrix = encode('https://box.tail1234.ts.net');
  assert.equal(matrix.length, 29, 'version 3');
  assert.deepEqual(rows(matrix), [
    '#######..#.#...##..##.#######',
    '#.....#...##.....##...#.....#',
    '#.###.#.###.#.#.#...#.#.###.#',
    '#.###.#.##.##...###.#.#.###.#',
    '#.###.#.#..#.###.####.#.###.#',
    '#.....#.##...#####....#.....#',
    '#######.#.#.#.#.#.#.#.#######',
    '........##.#.#.#..###........',
    '#.#####...#...##.#.#..#####..',
    '.##.#...#..#...#####..###...#',
    '###...##.#.......#...........',
    '######.##..#..#.#.#.##.#.#.#.',
    '##.####....#....##..#....##..',
    '..####..#.######..##.##.#...#',
    '##.##.###.##.####...##..###..',
    '.#####..#...##.#...#.......#.',
    '#....##....#..##.#..#..#.##..',
    '#####..#.####..##..#.####.#.#',
    '#.#.#######..........###..#..',
    '#...##..#...#.#.#.##...#...#.',
    '#.##.##..##.....#.#.#####.###',
    '........#...####.####...#####',
    '#######....#.#####.##.#.###..',
    '#.....#.###..#.#.##.#...#...#',
    '#.###.#.#.....##....#####.###',
    '#.###.#.#.#.#..##.##.....##..',
    '#.###.#.##........#..#######.',
    '#.....#...#...#.#..##.#..#.#.',
    '#######.######..#.#..#..#.#..',
  ]);
});

test('function patterns sit where the standard puts them, versions 1 to 10', () => {
  const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
  const alignment = ['#####', '#...#', '#.#.#', '#...#', '#####'];
  const block = (r, x, y, n) => r.slice(y, y + n).map((row) => row.slice(x, x + n));
  for (let version = 1; version <= 10; version++) {
    const r = rows(encode('x'.repeat(FILL[version - 1])));
    const size = version * 4 + 17;
    assert.equal(r.length, size, `version ${version} is ${size} modules`);
    assert.deepEqual(block(r, 0, 0, 7), finder);
    assert.deepEqual(block(r, size - 7, 0, 7), finder);
    assert.deepEqual(block(r, 0, size - 7, 7), finder);
    // Separators: the row and column just past each finder are light.
    assert.equal(r[7].slice(0, 8), '........');
    assert.equal(r[7].slice(size - 8), '........');
    assert.equal(r[size - 8].slice(0, 8), '........');
    // Timing patterns alternate, starting dark, between the finders.
    const timing = '#.'.repeat(size).slice(0, size - 16);
    assert.equal(r[6].slice(8, size - 8), timing);
    assert.equal(
      r
        .map((row) => row[6])
        .join('')
        .slice(8, size - 8),
      timing,
    );
    // The one module that is always dark.
    assert.equal(r[size - 8][8], '#');
    if (version >= 2) assert.deepEqual(block(r, size - 9, size - 9, 5), alignment);
  }
});

test('format information is level M, agrees between both copies, and passes BCH', () => {
  for (let version = 1; version <= 10; version++) {
    const m = encode('x'.repeat(FILL[version - 1]));
    const size = m.length;
    const at = (x, y) => (m[y][x] ? 1 : 0);
    let first = 0;
    for (let i = 0; i <= 5; i++) first |= at(8, i) << i;
    first |= at(8, 7) << 6;
    first |= at(8, 8) << 7;
    first |= at(7, 8) << 8;
    for (let i = 9; i < 15; i++) first |= at(14 - i, 8) << i;
    let second = 0;
    for (let i = 0; i < 8; i++) second |= at(size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) second |= at(8, size - 15 + i) << i;
    assert.equal(first, second, `version ${version}`);
    const value = first ^ 0x5412;
    const data = value >>> 10;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(value & 0x3ff, rem, 'BCH remainder');
    assert.equal(data >>> 3, 0b00, 'level M');
  }
});

test('the byte limit is exact and over it is a RangeError', () => {
  assert.equal(MAX_BYTES, 213);
  assert.equal(encode('x'.repeat(213)).length, 57, 'version 10');
  assert.throws(() => encode('x'.repeat(214)), RangeError);
  // The limit is in bytes, not characters.
  assert.throws(() => encode('✓'.repeat(72)), RangeError);
  assert.equal(encode('✓'.repeat(71)).length, 57);
});

test('render draws two modules per line with a four-module quiet zone, and parses back', () => {
  const matrix = encode('https://box.tail1234.ts.net');
  const text = render(matrix);
  const lines = text.split('\n');
  assert.equal(lines.at(-1), '', 'ends with a newline');
  lines.pop();
  const width = matrix.length + 8;
  assert.equal(lines.length, Math.ceil(width / 2));
  assert.equal(lines[0], '█'.repeat(width), 'top of the quiet zone');
  assert.equal(lines.at(-1), '█'.repeat(width), 'bottom of the quiet zone');
  const grid = [];
  for (const line of lines) {
    const top = [];
    const bottom = [];
    for (const ch of line) {
      assert.match(ch, /[█▀▄ ]/);
      top.push(ch === ' ' || ch === '▄');
      bottom.push(ch === ' ' || ch === '▀');
    }
    grid.push(top, bottom);
  }
  const inner = grid.slice(4, 4 + matrix.length).map((row) => row.slice(4, 4 + matrix.length));
  assert.deepEqual(inner, matrix);

  const colored = render(matrix, { color: true, indent: 2 }).split('\n');
  assert.equal(colored[0], '  \x1b[40;97m' + '█'.repeat(width) + '\x1b[0m');
});

test('the command line prints the plain rendering and refuses to run without text', async () => {
  const run = (args) => {
    const child = spawn(process.execPath, [join(repoRoot, 'qr.mjs'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    return once(child, 'exit').then(([code]) => ({ code, out, err }));
  };
  const ok = await run(['--indent', '2', 'https://box.tail1234.ts.net']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, render(encode('https://box.tail1234.ts.net'), { indent: 2 }));
  const colored = await run(['--color', 'hi']);
  assert.equal(colored.out, render(encode('hi'), { color: true }));
  const none = await run([]);
  assert.equal(none.code, 2);
  assert.match(none.err, /usage/);
  const long = await run(['x'.repeat(300)]);
  assert.equal(long.code, 1);
  assert.match(long.err, /holds at most 213/);
});
