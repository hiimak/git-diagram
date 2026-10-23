#!/usr/bin/env node
// git diagram [<git diff args>]: shows a diff as a file dependency diagram in the browser.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|def|func|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const JS_IMPORT = /\b(?:import|export)\s+(?:([\w$*\s{},]*?)\s*from\s*)?['"]([^'"\n]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const PY_IMPORT = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([^\n#)]*)|import[ \t]+([\w.][\w., \t]*))/gm;
const JS_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

const declName = line => line.match(DECL)?.[1];
const splitNames = s => (s || '').replace(/[{}()]/g, ' ').split(',')
  .map(n => n.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim()).filter(Boolean);

export function parseDiff(text) {
  const files = [];
  let f, inHunk;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/\1$/) ?? line.match(/^diff --git a\/(.*) b\/(.*)$/); // 1st form copes with spaces in unrenamed paths
      f = { path: m?.[2] ?? m?.[1] ?? '', oldPath: m?.[1] ?? '', status: 'modified', add: 0, del: 0, symbols: new Set(), diff: [] };
      files.push(f);
      inHunk = false;
    } else if (!f || line === '') {
      continue;
    } else if (line.startsWith('@@')) {
      inHunk = true;
      f.diff.push(line);
      const name = declName(line.replace(/^@@[^@]*@@ ?/, ''));
      if (name) f.symbols.add(name);
    } else if (inHunk) {
      f.diff.push(line);
      if (line[0] === '+' || line[0] === '-') {
        line[0] === '+' ? f.add++ : f.del++;
        const name = declName(line.slice(1));
        if (name) f.symbols.add(name);
      }
    } else if (line.startsWith('new file')) f.status = 'added';
    else if (line.startsWith('deleted file')) f.status = 'deleted';
    else if (line.startsWith('rename from ')) { f.status = 'renamed'; f.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) f.path = line.slice(10);
    else if (line.startsWith('--- a/')) f.oldPath = line.slice(6).replace(/\t$/, ''); // git adds a trailing tab when a path has spaces
    else if (line.startsWith('+++ b/')) f.path = line.slice(6).replace(/\t$/, '');
    else if (line.startsWith('Binary files')) f.diff.push(line);
  }
  return files.map(f => ({ ...f, symbols: [...f.symbols] }));
}

export function parseImports(path, text) {
  const imports = [];
  if (path.endsWith('.py')) {
    for (const [, from, names, plain] of text.matchAll(PY_IMPORT)) {
      if (from !== undefined) imports.push({ spec: from, names: splitNames(names) });
      else for (const mod of splitNames(plain)) imports.push({ spec: mod, names: [] });
    }
  } else {
    for (const [, names, spec, dynamic] of text.matchAll(JS_IMPORT)) imports.push({ spec: spec ?? dynamic, names: splitNames(names) });
  }
  return imports;
}

// Returns the repo files an import points at (only those present in `files`).
export function resolve(from, { spec, names }, files) {
  const dir = posix.dirname(from);
  const candidates = [];
  if (from.endsWith('.py')) {
    const dots = spec.match(/^\.*/)[0].length;
    const mod = spec.slice(dots).replaceAll('.', '/');
    // shortcut: absolute imports are only looked up from the repo root and src/; add more roots if a repo needs them
    const roots = dots ? [posix.join(dir, ...Array(dots - 1).fill('..'))] : ['', 'src'];
    for (const r of roots) {
      const base = posix.join(r, mod);
      candidates.push(mod ? [base + '.py', base + '/__init__.py'] : [base + '/__init__.py']);
      for (const n of names) candidates.push([posix.join(base, n) + '.py']);
    }
  } else {
    if (!spec.startsWith('.')) return []; // shortcut: bare packages and tsconfig path aliases are not followed
    const base = posix.join(dir, spec);
    candidates.push(JS_EXTS.map(e => base + e), JS_EXTS.slice(1).map(e => base.replace(/\.[cm]?js$/, '') + e));
  }
  return [...new Set(candidates.map(c => c.find(p => files.has(p))).filter(Boolean))];
}

// Import edges touching a changed file, oriented as data flow: imported file -> importer.
export function buildGraph(changed, paths, read) {
  const isChanged = new Set(changed.map(f => f.path));
  const edges = new Map();
  for (const p of paths) {
    if (!SOURCE.test(p)) continue;
    const text = read(p);
    if (text == null) continue;
    for (const imp of parseImports(p, text)) {
      for (const t of resolve(p, imp, paths)) {
        if (t === p || !(isChanged.has(p) || isChanged.has(t))) continue;
        const key = t + '\0' + p;
        const e = edges.get(key) ?? { from: t, to: p, names: new Set() };
        imp.names.forEach(n => e.names.add(n));
        edges.set(key, e);
      }
    }
  }
  return [...edges.values()].map(e => ({ ...e, names: [...e.names] }));
}

// Mermaid entity codes, so file content can never become markup or syntax.
const esc = s => String(s).replace(/[#&<>"]/g, c => `#${c.charCodeAt(0)};`);

export function toMermaid(nodes, edges) {
  const id = new Map(nodes.map((n, i) => [n.path, 'n' + i]));
  const out = ['flowchart LR'];
  let g = 0;
  const lanes = new Map();
  for (const n of nodes) lanes.set(posix.dirname(n.path), [...(lanes.get(posix.dirname(n.path)) ?? []), n]);
  for (const [dir, lane] of lanes) {
    out.push(`subgraph g${g++}["${esc(dir === '.' ? '(root)' : dir + '/')}"]`);
    for (const n of lane) {
      const stat = n.status === 'context' ? 'unchanged' : `${n.status} · +${n.add} −${n.del}`;
      const syms = n.symbols.slice(0, 6).map(s => '<br/>ƒ ' + esc(s)).join('') + (n.symbols.length > 6 ? `<br/>… +${n.symbols.length - 6} more` : '');
      out.push(`${id.get(n.path)}["<b>${esc(posix.basename(n.path))}</b><br/><small>${stat}</small>${syms}"]:::${n.status}`);
    }
    out.push('end');
  }
  for (const e of edges) {
    const names = e.names.slice(0, 3).join(', ') + (e.names.length > 3 ? ', …' : '');
    out.push(`${id.get(e.from)} -->${names ? `|"${esc(names)}"|` : ''} ${id.get(e.to)}`);
  }
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = (a, env) => execFileSync('git', ['-c', 'core.quotePath=false', ...a], { cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] });
  const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
  const diff = ['diff', '--no-color', '--no-ext-diff', '-M'];

  let text;
  if (args.length) text = run([...diff, ...args]);
  else {
    // Stage everything (untracked files included) into a throwaway copy of the index, so renames of untracked files are detected and the real index is untouched.
    const tmp = join(gitDir, 'git-diagram.index'), env = { ...process.env, GIT_INDEX_FILE: tmp };
    try { copyFileSync(join(gitDir, 'index'), tmp); } catch {}
    try {
      execFileSync('git', ['add', '-A'], { cwd: root, env, stdio: 'ignore' });
      let base = EMPTY_TREE;
      try { base = run(['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch {} // no commits yet
      text = run([...diff, '--cached', base], env);
    } finally { rmSync(tmp, { force: true }); }
  }
  const files = parseDiff(text);
  if (!files.length) return console.log('No changes.');

  const paths = new Set([...run(['ls-files', '-z']).split('\0').filter(Boolean), ...files.map(f => f.path)]);
  // shortcut: imports are read from the working tree, so for old commit ranges they reflect today's code
  const read = p => { try { return statSync(join(root, p)).size > 1e6 ? null : readFileSync(join(root, p), 'utf8'); } catch { return null; } };
  const edges = buildGraph(files, paths, read);
  const changed = new Set(files.map(f => f.path));
  const context = [...new Set(edges.flatMap(e => [e.from, e.to]))].filter(p => !changed.has(p))
    .map(path => ({ path, oldPath: path, status: 'context', add: 0, del: 0, symbols: [], diff: [] }));
  const nodes = [...files, ...context];

  const data = JSON.stringify({
    nodes, edges, mermaid: toMermaid(nodes, edges), range: args.join(' ') || 'uncommitted changes',
    mermaidChanged: toMermaid(files, edges.filter(e => changed.has(e.from) && changed.has(e.to))),
  }).replace(/</g, '\u003c');
  const out = join(gitDir, 'git-diagram.html');
  writeFileSync(out, readFileSync(new URL('./page.html', import.meta.url), 'utf8').replace('__DATA__', () => data));
  const [cmd, cmdArgs] = { win32: ['explorer.exe', [out]], darwin: ['open', [out]] }[process.platform] ?? ['xdg-open', [out]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  console.log(`${files.length} changed files, ${edges.length} connections -> ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (e) { if (e.status) process.exit(e.status); throw e; }
}
