import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, parseImports, resolve, buildGraph, toMermaid, parseArgs, excludePathspecs } from './git-diagram.mjs';

const DIFF = `diff --git a/src/api.ts b/src/api.ts
index 1111111..2222222 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,4 @@ export function load() {
 import { db } from './db';
+export const fetchUser = (id: string) => db.get(id);
--- old comment line
 const x = 1;
diff --git a/src/new.py b/src/new.py
new file mode 100644
--- /dev/null
+++ b/src/new.py
@@ -0,0 +1,2 @@
+def handler(event):
+    return event
diff --git a/old.js b/old.js
deleted file mode 100644
--- a/old.js
+++ /dev/null
@@ -1 +0,0 @@
-module.exports = 1;
diff --git a/a b.txt b/c d.txt
similarity index 100%
rename from a b.txt
rename to c d.txt
`;

test('parseDiff reads status, counts, symbols and paths', () => {
  const [api, py, old, ren] = parseDiff(DIFF);
  assert.deepEqual([api.path, api.status, api.add, api.del], ['src/api.ts', 'modified', 1, 1]);
  assert.deepEqual(api.symbols, ['load', 'fetchUser']);
  assert.deepEqual([py.status, py.add, py.symbols], ['added', 2, ['handler']]);
  assert.deepEqual([old.path, old.status, old.del], ['old.js', 'deleted', 1]);
  assert.deepEqual([ren.oldPath, ren.path, ren.status, ren.diff], ['a b.txt', 'c d.txt', 'renamed', []]);
});

test('parseDiff handles spaces in paths (trailing tab, mode-only change)', () => {
  const [a, b] = parseDiff('diff --git a/my dir/x y.ts b/my dir/x y.ts\n--- a/my dir/x y.ts\t\n+++ b/my dir/x y.ts\t\n@@ -1 +1,2 @@\n a\n+b\ndiff --git a/p q.sh b/p q.sh\nold mode 100644\nnew mode 100755\n');
  assert.deepEqual([a.path, a.oldPath, a.add], ['my dir/x y.ts', 'my dir/x y.ts', 1]);
  assert.deepEqual([b.path, b.oldPath], ['p q.sh', 'p q.sh']);
});

test('parseDiff reads a Buffer and caps huge diffs', () => {
  const [f] = parseDiff(Buffer.from('diff --git a/big.txt b/big.txt\nnew file mode 100644\n@@ -0,0 +1,6000 @@\n' + '+x\n'.repeat(6000)));
  assert.deepEqual([f.status, f.add, f.diff.length], ['added', 6000, 5001]);
  assert.match(f.diff.at(-1), /more lines not shown/);
});

test('parseImports handles JS/TS and Python forms', () => {
  assert.deepEqual(parseImports('a.ts', `import React, { useState as s } from 'react';
import type { User } from "./types";
export * from './all';
import './side.css';
const x = require('../x');
const y = await import('./lazy');`), [
    { spec: 'react', names: ['React', 'useState'] },
    { spec: './types', names: ['User'] },
    { spec: './all', names: ['*'] },
    { spec: './side.css', names: [] },
    { spec: '../x', names: [] },
    { spec: './lazy', names: [] },
  ]);
  assert.deepEqual(parseImports('p/m.py', 'import os, pkg.util as u\nfrom . import helpers\nfrom ..core.models import (User, Order)\n'), [
    { spec: 'os', names: [] },
    { spec: 'pkg.util', names: [] },
    { spec: '.', names: ['helpers'] },
    { spec: '..core.models', names: ['User', 'Order'] },
  ]);
});

test('resolve maps imports to repo files', () => {
  const files = new Set(['src/db.ts', 'src/lib/index.tsx', 'src/esm.ts', 'app/core/models.py', 'app/web/helpers.py', 'app/web/__init__.py']);
  assert.deepEqual(resolve('src/api.ts', { spec: './db', names: [] }, files), ['src/db.ts']);
  assert.deepEqual(resolve('src/api.ts', { spec: './lib', names: [] }, files), ['src/lib/index.tsx']);
  assert.deepEqual(resolve('src/api.ts', { spec: './esm.js', names: [] }, files), ['src/esm.ts']);
  assert.deepEqual(resolve('src/api.ts', { spec: 'react', names: [] }, files), []);
  assert.deepEqual(resolve('app/web/view.py', { spec: '..core.models', names: ['User'] }, files), ['app/core/models.py']);
  assert.deepEqual(resolve('app/web/view.py', { spec: '.', names: ['helpers'] }, files), ['app/web/__init__.py', 'app/web/helpers.py']);
  assert.deepEqual(resolve('main.py', { spec: 'app.core.models', names: [] }, files), ['app/core/models.py']);
});

test('buildGraph keeps only edges touching changed files, as data flow', () => {
  const src = { 'a.ts': "import { b } from './b'", 'b.ts': "import { c } from './c'", 'c.ts': '', 'z.ts': "import './c'" };
  const edges = buildGraph([{ path: 'b.ts' }], new Set(Object.keys(src)), p => src[p]);
  assert.deepEqual(edges, [{ from: 'b.ts', to: 'a.ts', names: ['b'] }, { from: 'c.ts', to: 'b.ts', names: ['c'] }]);
});

test('toMermaid escapes file content', () => {
  const m = toMermaid([{ path: 'x/<b>"#.ts', status: 'added', add: 1, del: 0, symbols: [] }], []);
  assert.match(m, /#60;b#62;#34;#35;\.ts/);
  assert.doesNotMatch(m, /<b>"/);
});

test('parseArgs splits -i / --ignore from git diff arguments', () => {
  assert.deepEqual(parseArgs(['-i', '*.lock', 'main...HEAD', '--ignore=dist', '--', 'src']),
    { ignore: ['*.lock', 'dist'], gitArgs: ['main...HEAD', '--', 'src'] });
  assert.deepEqual(excludePathspecs(['*.lock', 'src/gen/']),
    [':(exclude,glob)**/*.lock', ':(exclude,glob)**/*.lock/**', ':(exclude,glob)src/gen', ':(exclude,glob)src/gen/**']);
});
