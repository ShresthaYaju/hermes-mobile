// Module wiring integrity.
//
// This app ships raw ES modules to the browser: no bundler, no build step, no
// type checker. So an import of a name the target module does not export is not
// caught by anything -- the browser refuses the whole module graph at link time
// and the app renders a blank screen. Every other test here would still pass.
//
// The same is true of the service worker's precache list: `cache.add()` on a
// path that does not exist fails silently (install deliberately tolerates it),
// and the file is simply absent offline.
//
// Both are exactly the mistakes that parallel work on separate files produces,
// so they get pinned here rather than discovered on a phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

/** Every shipped module, as paths relative to public/. */
function modules() {
  const found = readdirSync(publicDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => name);
  for (const dir of ['lib', 'views']) {
    for (const name of readdirSync(join(publicDir, dir))) {
      if (name.endsWith('.js')) found.push(`${dir}/${name}`);
    }
  }
  return found;
}

const read = (relative) => readFileSync(join(publicDir, relative), 'utf8');

/**
 * Named exports of a module. Covers the three forms this codebase uses:
 * `export function f`, `export const c`, and `export { a, b }`.
 */
function exportsOf(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Static imports of a module: `[{ from, names }]`, relative specifiers only. */
function importsOf(source) {
  const found = [];
  const pattern = /import\s+(?:\{([^}]*)\}|([A-Za-z0-9_$]+))\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const names = match[1]
      ? match[1]
          .split(',')
          .map((part) =>
            part
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim(),
          )
          .filter(Boolean)
      : [];
    found.push({ from: match[3], names });
  }
  return found;
}

test('every named import resolves to a real export', () => {
  const problems = [];

  for (const relative of modules()) {
    const source = read(relative);
    for (const { from, names } of importsOf(source)) {
      const target = resolve(dirname(join(publicDir, relative)), from);

      if (!existsSync(target)) {
        problems.push(`${relative} imports missing module ${from}`);
        continue;
      }

      const available = exportsOf(readFileSync(target, 'utf8'));
      for (const name of names) {
        if (!available.has(name)) {
          problems.push(`${relative} imports { ${name} } from ${from}, which does not export it`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `unresolved imports would blank the app:\n${problems.join('\n')}`);
});

test('every module the service worker precaches exists', () => {
  const worker = read('service-worker.js');
  const block = worker.match(/const ASSETS = \[([\s\S]*?)\]/);
  assert.ok(block, 'ASSETS list not found in service-worker.js');

  const missing = [...block[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    // '/' is the navigation request, served by index.html rather than a file.
    .filter((path) => path !== '/')
    .filter((path) => !existsSync(join(publicDir, path.replace(/^\//, ''))));

  assert.deepEqual(missing, [], `precached but absent on disk: ${missing.join(', ')}`);
});

test('every stylesheet the shell links exists', () => {
  const html = read('index.html');
  const missing = [...html.matchAll(/<link[^>]+href="(\/[^"]+\.css)"/g)]
    .map((match) => match[1])
    .filter((path) => !existsSync(join(publicDir, path.replace(/^\//, ''))));

  assert.deepEqual(missing, [], `linked but absent on disk: ${missing.join(', ')}`);
});

test('no module imports a file owned by another area through a stale path', () => {
  // The parallel build moved per-area CSS into public/styles/. A JS module
  // reaching for a stylesheet, or for anything outside public/, is a wiring
  // mistake rather than a style choice.
  const offenders = [];
  for (const relative of modules()) {
    for (const { from } of importsOf(read(relative))) {
      if (from.endsWith('.css') || from.includes('..//') || from.includes('node_modules')) {
        offenders.push(`${relative} -> ${from}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
