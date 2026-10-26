#!/usr/bin/env node
// git diagram [<git diff arguments>]
//
// Shows a git diff as a diagram in the browser: one box per changed file, arrows for
// "this file imports that file" (data flow), and a click on a box shows that file's diff.
//
// How it works, step by step (see main() at the bottom):
//   1. getDiffText   ask git for the diff
//   2. parseDiff     turn the diff text into a list of changed files
//   3. buildGraph    find which files import which (the arrows)
//   4. toMermaid     turn files + arrows into diagram source text
//   5. renderPage    put everything into page.html, write it, open it in the browser

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

// git's hash for "an empty tree". Diffing against it shows every file as added.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const MAX_FILE_SIZE = 1e6; // bytes. Bigger files are not scanned for imports.

// Only these files are scanned for imports: JavaScript, TypeScript, Python.
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py)$/;

// A line that declares something with a name, like `export async function load`,
// `class User`, `def run` or `const total =`. Captures the name.
const DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|def|func|const|let|var)\s+([A-Za-z_$][\w$]*)/;

// JavaScript / TypeScript imports. Three forms, one regex:
//   import { a, b } from './x'      and   export * from './x'   -> names = "{ a, b }", spec = "./x"
//   import './x'                                                -> no names
//   require('./x')   and   import('./x')                        -> spec only (third capture group)
const JS_IMPORT = /\b(?:import|export)\s+(?:([\w$*\s{},]*?)\s*from\s*)?['"]([^'"\n]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

// Python imports, one regex with two shapes:
//   from .pkg import a, b   -> module = ".pkg", names = "a, b"
//   import pkg.mod, other   -> plain = "pkg.mod, other"
const PY_IMPORT = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([^\n#)]*)|import[ \t]+([\w.][\w., \t]*))/gm;

// What an import like './x' can point at: the file itself, with an extension, or a folder's index file.
const JS_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

// ---------------------------------------------------------------------------------------
// Step 2: read the diff
// ---------------------------------------------------------------------------------------

// Turns the text of a unified diff into one object per changed file:
//   { path, oldPath, status, add, del, symbols, diff }
//   status:  'added' | 'modified' | 'deleted' | 'renamed'
//   add/del: number of added / removed lines
//   symbols: names of functions, classes... that the change touches
//   diff:    the hunk lines (@@ headers, context, + and - lines) shown in the side panel
export function parseDiff(diffText) {
  const files = [];
  let file;            // the file whose section we are reading right now
  let inHunk = false;  // true once we are past the file's header lines

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = startFile(line);
      files.push(file);
      inHunk = false;
    } else if (!file || line === '') {
      continue;
    } else if (line.startsWith('@@')) {
      inHunk = true;
      file.diff.push(line);
      // after the closing @@ git prints the function the hunk sits in
      addSymbol(file, line.replace(/^@@[^@]*@@ ?/, ''));
    } else if (inHunk) {
      file.diff.push(line);
      const sign = line[0];
      if (sign === '+' || sign === '-') {
        if (sign === '+') file.add++; else file.del++;
        addSymbol(file, line.slice(1));
      }
    } else {
      readHeaderLine(file, line);
    }
  }
  return files.map(f => ({ ...f, symbols: [...f.symbols] }));
}

function startFile(headerLine) {
  // `diff --git a/<old path> b/<new path>`. If nothing was renamed both paths are equal, and
  // matching that way also copes with spaces in the path. A rename is corrected later from
  // the `rename from` / `rename to` lines.
  const m = headerLine.match(/^diff --git a\/(.+) b\/\1$/) ?? headerLine.match(/^diff --git a\/(.*) b\/(.*)$/);
  return { path: m?.[2] ?? m?.[1] ?? '', oldPath: m?.[1] ?? '', status: 'modified', add: 0, del: 0, symbols: new Set(), diff: [] };
}

// The lines between `diff --git` and the first `@@`: status, rename info, paths.
function readHeaderLine(file, line) {
  if (line.startsWith('new file')) file.status = 'added';
  else if (line.startsWith('deleted file')) file.status = 'deleted';
  else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice('rename from '.length); }
  else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length);
  else if (line.startsWith('--- a/')) file.oldPath = stripTrailingTab(line.slice('--- a/'.length));
  else if (line.startsWith('+++ b/')) file.path = stripTrailingTab(line.slice('+++ b/'.length));
  else if (line.startsWith('Binary files')) file.diff.push(line);
}

// git adds a tab after the path in `---` / `+++` lines when the path contains spaces.
const stripTrailingTab = path => path.replace(/\t$/, '');

function addSymbol(file, sourceLine) {
  const name = sourceLine.match(DECLARATION)?.[1];
  if (name) file.symbols.add(name);
}

// ---------------------------------------------------------------------------------------
// Step 3: find the arrows (which file imports which)
// ---------------------------------------------------------------------------------------

// Lists the imports in one file as { spec, names }:
//   spec:  what is written after `from` (for example './db' or '.models')
//   names: the imported names (for example ['db', 'connect']); empty for `import './x'`
export function parseImports(path, source) {
  const imports = [];
  if (path.endsWith('.py')) {
    for (const [, fromModule, fromNames, plainModules] of source.matchAll(PY_IMPORT)) {
      if (fromModule !== undefined) imports.push({ spec: fromModule, names: parseNameList(fromNames) });
      else for (const module of parseNameList(plainModules)) imports.push({ spec: module, names: [] });
    }
  } else {
    for (const [, names, spec, callSpec] of source.matchAll(JS_IMPORT)) {
      imports.push({ spec: spec ?? callSpec, names: parseNameList(names) });
    }
  }
  return imports;
}

// "{ a as b, type C }" -> ['a', 'C']
function parseNameList(text) {
  return (text || '').replace(/[{}()]/g, ' ').split(',')
    .map(name => name.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim())
    .filter(Boolean);
}

// Finds the repo file(s) one import points at. `repoFiles` is the set of all file paths in the repo.
// Returns [] for anything that is not a file in the repo (for example an npm package).
export function resolve(importingFile, imp, repoFiles) {
  const candidates = importingFile.endsWith('.py') ? pythonCandidates(importingFile, imp) : jsCandidates(importingFile, imp);
  // Each candidate group lists alternative spellings of one possible target; take the first that exists.
  return [...new Set(candidates.map(group => group.find(path => repoFiles.has(path))).filter(Boolean))];
}

function jsCandidates(importingFile, { spec }) {
  // shortcut: bare packages and tsconfig path aliases are not followed
  if (!spec.startsWith('.')) return [];
  const base = posix.join(posix.dirname(importingFile), spec);
  return [
    JS_SUFFIXES.map(suffix => base + suffix),
    // TypeScript code often imports './x.js' for a file that is really './x.ts'
    JS_SUFFIXES.slice(1).map(suffix => base.replace(/\.[cm]?js$/, '') + suffix),
  ];
}

function pythonCandidates(importingFile, { spec, names }) {
  const dots = spec.match(/^\.*/)[0].length;          // leading dots of a relative import
  const module = spec.slice(dots).replaceAll('.', '/');
  const here = posix.dirname(importingFile);
  // shortcut: absolute imports are only looked up from the repo root and src/; add more roots if a repo needs them
  const roots = dots ? [posix.join(here, ...Array(dots - 1).fill('..'))] : ['', 'src'];

  const candidates = [];
  for (const root of roots) {
    const base = posix.join(root, module);
    candidates.push(module ? [base + '.py', base + '/__init__.py'] : [base + '/__init__.py']);
    // `from pkg import name` may mean the submodule pkg/name.py
    for (const name of names) candidates.push([posix.join(base, name) + '.py']);
  }
  return candidates;
}

// Builds the arrows: every import that involves at least one changed file.
// Direction is data flow: from the imported file to the file that imports it.
// `readFile(path)` returns a file's text, or null if it cannot be read.
export function buildGraph(changedFiles, repoFiles, readFile) {
  const changed = new Set(changedFiles.map(f => f.path));
  const edges = new Map(); // one entry per (imported, importer) pair: { from, to, names }

  for (const importer of repoFiles) {
    if (!SOURCE_FILE.test(importer)) continue;
    const source = readFile(importer);
    if (source == null) continue;

    for (const imp of parseImports(importer, source)) {
      for (const imported of resolve(importer, imp, repoFiles)) {
        const involvesChange = changed.has(importer) || changed.has(imported);
        if (imported === importer || !involvesChange) continue;

        const key = `${imported}\n${importer}`; // file paths never contain a newline
        const edge = edges.get(key) ?? { from: imported, to: importer, names: new Set() };
        imp.names.forEach(name => edge.names.add(name));
        edges.set(key, edge);
      }
    }
  }
  return [...edges.values()].map(edge => ({ ...edge, names: [...edge.names] }));
}

// ---------------------------------------------------------------------------------------
// Step 4: diagram source (Mermaid flowchart)
// ---------------------------------------------------------------------------------------

// Mermaid reads `#34;` as a literal `"`. Escaping like this means a file name can never
// break the diagram syntax or inject HTML.
const escapeMermaid = text => String(text).replace(/[#&<>"]/g, ch => `#${ch.charCodeAt(0)};`);

// `nodes` are changed files plus unchanged neighbours; `edges` are the arrows.
// Each folder becomes a lane (a Mermaid subgraph) holding the boxes of its files.
export function toMermaid(nodes, edges) {
  const id = new Map(nodes.map((node, i) => [node.path, 'n' + i])); // n0, n1, ... (the page relies on these ids)
  const lines = ['flowchart LR'];

  const lanes = new Map(); // folder -> its files
  for (const node of nodes) {
    const folder = posix.dirname(node.path);
    lanes.set(folder, [...(lanes.get(folder) ?? []), node]);
  }
  let laneNumber = 0;
  for (const [folder, laneNodes] of lanes) {
    lines.push(`subgraph g${laneNumber++}["${escapeMermaid(folder === '.' ? '(root)' : folder + '/')}"]`);
    for (const node of laneNodes) lines.push(`${id.get(node.path)}["${boxLabel(node)}"]:::${node.status}`);
    lines.push('end');
  }
  for (const edge of edges) {
    lines.push(`${id.get(edge.from)} -->${arrowLabel(edge)} ${id.get(edge.to)}`);
  }
  return lines.join('\n');
}

// The text inside a box: file name, status with line counts, then the touched symbols (max 6).
function boxLabel(node) {
  const stats = node.status === 'context' ? 'unchanged' : `${node.status} · +${node.add} −${node.del}`;
  const shown = node.symbols.slice(0, 6).map(name => '<br/>ƒ ' + escapeMermaid(name)).join('');
  const hidden = node.symbols.length > 6 ? `<br/>… +${node.symbols.length - 6} more` : '';
  return `<b>${escapeMermaid(posix.basename(node.path))}</b><br/><small>${stats}</small>${shown}${hidden}`;
}

// The text on an arrow: the first three imported names.
function arrowLabel(edge) {
  const names = edge.names.slice(0, 3).join(', ') + (edge.names.length > 3 ? ', …' : '');
  return names ? `|"${escapeMermaid(names)}"|` : '';
}

// ---------------------------------------------------------------------------------------
// Steps 1 and 5: talking to git, writing and opening the page
// ---------------------------------------------------------------------------------------

// Finds the repo and returns a helper for running git inside it.
function openRepo() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = (args, env) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
  return { root, gitDir, run };
}

const DIFF_FLAGS = ['diff', '--no-color', '--no-ext-diff', '-M']; // -M: detect renames

// With arguments, they go straight to `git diff`. Without, we diff everything not committed yet.
function getDiffText(repo, args) {
  return args.length ? repo.run([...DIFF_FLAGS, ...args]) : diffEverythingUncommitted(repo);
}

// A plain `git diff HEAD` skips new (untracked) files, and git cannot pair a renamed
// untracked file with its old name. So we stage everything into a throwaway copy of the
// index and diff that. Your real index and files are never touched.
function diffEverythingUncommitted({ root, gitDir, run }) {
  const tempIndex = join(gitDir, 'git-diagram.index');
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try { copyFileSync(join(gitDir, 'index'), tempIndex); } catch { /* no index yet: start empty */ }
  try {
    execFileSync('git', ['add', '-A'], { cwd: root, env, stdio: 'ignore' });
    let base = EMPTY_TREE;
    try { base = run(['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch { /* repo has no commits yet */ }
    return run([...DIFF_FLAGS, '--cached', base], env);
  } finally {
    rmSync(tempIndex, { force: true });
  }
}

// Fills page.html with the data. The data goes in as JSON inside a <script> tag, so every `<`
// is escaped to keep file content from closing the tag.
function renderPage(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const template = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
  return template.replace('__DATA__', () => json);
}

function openInBrowser(file) {
  const [command, args] = { win32: ['explorer.exe', [file]], darwin: ['open', [file]] }[process.platform] ?? ['xdg-open', [file]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

function main() {
  const args = process.argv.slice(2);
  const repo = openRepo();

  const files = parseDiff(getDiffText(repo, args));
  if (!files.length) return console.log('No changes.');

  // Arrows. Imports are read from the working tree.
  // shortcut: so for an old commit range they reflect today's code, not the code of that time
  const repoFiles = new Set([...repo.run(['ls-files', '-z']).split('\0').filter(Boolean), ...files.map(f => f.path)]);
  const readFile = path => {
    try {
      const full = join(repo.root, path);
      return statSync(full).size > MAX_FILE_SIZE ? null : readFileSync(full, 'utf8');
    } catch { return null; }
  };
  const edges = buildGraph(files, repoFiles, readFile);

  // Unchanged files that an arrow touches are shown too (status 'context'), so you see what a change can affect.
  const changedPaths = new Set(files.map(f => f.path));
  const neighbours = [...new Set(edges.flatMap(e => [e.from, e.to]))].filter(path => !changedPaths.has(path))
    .map(path => ({ path, oldPath: path, status: 'context', add: 0, del: 0, symbols: [], diff: [] }));
  const nodes = [...files, ...neighbours]; // changed files first: the page relies on this order

  const html = renderPage({
    nodes,
    edges,
    mermaid: toMermaid(nodes, edges),
    mermaidChanged: toMermaid(files, edges.filter(e => changedPaths.has(e.from) && changedPaths.has(e.to))), // same diagram without neighbours
    range: args.join(' ') || 'uncommitted changes',
  });
  const out = join(repo.gitDir, 'git-diagram.html');
  writeFileSync(out, html);
  openInBrowser(out);
  // a file:// URL is clickable in most terminals, unlike a bare Windows path
  console.log(`git diagram: ${files.length} changed files, ${edges.length} connections`);
  console.log(`Opening it in your browser. If nothing opens, follow this link:\n  ${pathToFileURL(out).href}`);
}

// Run main() only when started as a command, not when the tests import this file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (e) { if (e.status) process.exit(e.status); throw e; }
}
