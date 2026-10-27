#!/usr/bin/env node
// git diagram [-i <pattern>]... [<git diff arguments>]
//   -i, --ignore <pattern>   leave out matching files, like .gitignore: `-i dist -i '*.lock' -i 'src/**/*.gen.ts'`
//
// Shows a git diff as a diagram in the browser: one box per changed file, arrows for
// "this file imports that file" (data flow), and a click on a box shows that file's diff.
//
// How it works, step by step (see main() at the bottom):
//   1. getDiffText   ask git for the diff
//   2. parseDiff     turn the diff text into a list of changed files
//   3. buildGraph    find which files use which, read with tree-sitter (lib/graph.mjs, lib/parse.mjs)
//   4. toMermaid     turn files + arrows into diagram source text
//   5. renderPage    put everything into page.html, write it, open it in the browser

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraph } from './lib/graph.mjs';

// git's hash for "an empty tree". Diffing against it shows every file as added.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const MAX_FILE_SIZE = 1e6; // bytes. Bigger files are not read for imports.

// Per file, only this many diff lines go into the page (the +/- counts still cover all of them),
// and each line is cut at MAX_LINE_LENGTH characters. Keeps huge diffs from blowing up the page.
const MAX_DIFF_LINES = 5000;
const MAX_LINE_LENGTH = 2000;

// A line that declares something with a name, like `export async function load`, `class User`,
// `def run`, `const total =`, `public final class Order`, `data class Item` or Go's
// `func (s *Store) Save` (the receiver is skipped). Captures the keyword and the name.
const DECLARATION = /^\s*(?:(?:export|default|async|public|private|protected|internal|static|final|abstract|sealed|open|data|enum|inner|value|override|suspend|partial|readonly|virtual|unsafe)\s+)*(function|class|interface|record|struct|object|type|enum|def|func|fun|const|let|var|val)\*?\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/;

// keyword -> the kind shown in the box; types keep their own keyword (class, interface, enum...)
const KIND = { function: 'function', def: 'function', func: 'function', fun: 'function', const: 'variable', let: 'variable', var: 'variable', val: 'variable' };

// ---------------------------------------------------------------------------------------
// Step 2: read the diff
// ---------------------------------------------------------------------------------------

// Turns the text of a unified diff into one object per changed file:
//   { path, oldPath, status, add, del, symbols, diff }
//   status:  'added' | 'modified' | 'deleted' | 'renamed'
//   add/del: number of added / removed lines
//   symbols: functions, classes, variables... that the change touches, as [{ name, kind }]
//            kind: 'function' | 'variable' | the type keyword ('class', 'interface', 'enum', ...)
//   diff:    the hunk lines (@@ headers, context, + and - lines) shown in the side panel
//   cut:     (internal) diff lines left out of `diff` because the file's diff is huge
// Takes a string or, for diffs too big for one string, a Buffer.
export function parseDiff(diffText) {
  const files = [];
  let file;            // the file whose section we are reading right now
  let inHunk = false;  // true once we are past the file's header lines

  for (const line of splitLines(diffText)) {
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
      if (file.diff.length < MAX_DIFF_LINES) file.diff.push(line); else file.cut++;
      const sign = line[0];
      if (sign === '+' || sign === '-') {
        if (sign === '+') file.add++; else file.del++;
        addSymbol(file, line.slice(1));
      }
    } else {
      readHeaderLine(file, line);
    }
  }
  for (const f of files) if (f.cut) f.diff.push(`@@ ${f.cut} more lines not shown: this file's diff is too big for the page @@`);
  return files.map(({ cut, ...f }) => ({ ...f, symbols: [...f.symbols].map(([name, kind]) => ({ name, kind })) }));
}

// Lines of a string or Buffer. A Buffer is decoded one line at a time, because a diff can be
// bigger than the longest string JavaScript allows (about 512 MB).
function* splitLines(text) {
  if (typeof text === 'string') { for (const line of text.split('\n')) yield line.slice(0, MAX_LINE_LENGTH); return; }
  for (let start = 0; start < text.length;) {
    let end = text.indexOf(10, start);
    if (end < 0) end = text.length;
    yield text.toString('utf8', start, Math.min(end, start + MAX_LINE_LENGTH));
    start = end + 1;
  }
}

function startFile(headerLine) {
  // `diff --git a/<old path> b/<new path>`. If nothing was renamed both paths are equal, and
  // matching that way also copes with spaces in the path. A rename is corrected later from
  // the `rename from` / `rename to` lines.
  const m = headerLine.match(/^diff --git a\/(.+) b\/\1$/) ?? headerLine.match(/^diff --git a\/(.*) b\/(.*)$/);
  return { path: m?.[2] ?? m?.[1] ?? '', oldPath: m?.[1] ?? '', status: 'modified', add: 0, del: 0, symbols: new Map(), diff: [], cut: 0 };
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
  const [, keyword, name] = sourceLine.match(DECLARATION) ?? [];
  if (name && !file.symbols.has(name)) file.symbols.set(name, KIND[keyword] ?? keyword);
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
  const shown = node.symbols.slice(0, 6).map(({ name, kind }) => `<br/><i>${escapeMermaid(kind)}</i> ${escapeMermaid(name)}`).join('');
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
  // encoding 'buffer' returns raw bytes, for output that may not fit in one string (the diff)
  const run = (args, env, encoding = 'utf8') => execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root, env, encoding, maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
  return { root, gitDir, run };
}

const DIFF_FLAGS = ['diff', '--no-color', '--no-ext-diff', '-M']; // -M: detect renames

// Splits the command line into our own -i / --ignore patterns and the rest, which goes to `git diff`.
export function parseArgs(argv) {
  const ignore = [], gitArgs = [];
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--') { gitArgs.push(...argv.slice(k)); break; }
    if (arg === '-i' || arg === '--ignore') ignore.push(argv[++k] ?? '');
    else if (arg.startsWith('--ignore=')) ignore.push(arg.slice('--ignore='.length));
    else gitArgs.push(arg);
  }
  return { ignore: ignore.filter(Boolean), gitArgs };
}

// Turns ignore patterns into git "exclude" pathspecs with .gitignore-like meaning: a pattern
// without a slash matches at any depth (`*.lock`, `node_modules`), and a matched folder
// takes everything inside it along.
export function excludePathspecs(patterns) {
  return patterns.flatMap(pattern => {
    const base = pattern.includes('/') ? pattern.replace(/^\/|\/$/g, '') : '**/' + pattern;
    return [`:(exclude,glob)${base}`, `:(exclude,glob)${base}/**`];
  });
}

// With arguments, they go straight to `git diff`. Without, we diff everything not committed yet.
// `excludes` (pathspecs) go last, after a `--` if the arguments have none.
function getDiffText(repo, args, excludes) {
  if (!args.length) return diffEverythingUncommitted(repo, excludes);
  const paths = args.includes('--') ? excludes : excludes.length ? ['--', ...excludes] : [];
  return repo.run([...DIFF_FLAGS, ...args, ...paths], undefined, 'buffer');
}

// A plain `git diff HEAD` skips new (untracked) files, and git cannot pair a renamed
// untracked file with its old name. So we stage everything into a throwaway copy of the
// index and diff that. Your real index and files are never touched.
function diffEverythingUncommitted({ root, gitDir, run }, excludes) {
  const tempIndex = join(gitDir, 'git-diagram.index');
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try { copyFileSync(join(gitDir, 'index'), tempIndex); } catch { /* no index yet: start empty */ }
  try {
    execFileSync('git', ['add', '-A', '--', ...excludes], { cwd: root, env, stdio: 'ignore' }); // ignored files are never even read
    let base = EMPTY_TREE;
    try { base = run(['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch { /* repo has no commits yet */ }
    return run([...DIFF_FLAGS, '--cached', base, '--', ...excludes], env, 'buffer');
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

async function main() {
  const { ignore, gitArgs: args } = parseArgs(process.argv.slice(2));
  const excludes = excludePathspecs(ignore);
  const repo = openRepo();

  const files = parseDiff(getDiffText(repo, args, excludes));
  if (!files.length) return console.log('No changes.');

  // Arrows. Imports are read from the working tree.
  // shortcut: so for an old commit range they reflect today's code, not the code of that time
  const repoFiles = new Set([...repo.run(['ls-files', '-z', '--', ...excludes]).split('\0').filter(Boolean), ...files.map(f => f.path)]);
  const readFile = path => {
    try {
      const full = join(repo.root, path);
      return statSync(full).size > MAX_FILE_SIZE ? null : readFileSync(full, 'utf8');
    } catch { return null; }
  };
  const edges = await buildGraph(files, repoFiles, readFile);

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
    range: (args.join(' ') || 'uncommitted changes') + (ignore.length ? ` · ignoring ${ignore.join(' ')}` : ''),
  });
  const out = join(repo.gitDir, 'git-diagram.html');
  writeFileSync(out, html);
  openInBrowser(out);
  // a file:// URL is clickable in most terminals, unlike a bare Windows path
  console.log(`git diagram: ${files.length} changed files, ${edges.length} connections`);
  console.log(`Opening it in your browser. If nothing opens, follow this link:\n  ${pathToFileURL(out).href}`);
}

// Run main() only when started as a command, not when the tests import this file.
// realpath: on Linux/macOS npm installs the command as a symlink to this file.
const startedAs = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === startedAs) {
  main().catch(e => { if (e.status) process.exit(e.status); console.error(e); process.exit(1); });
}
