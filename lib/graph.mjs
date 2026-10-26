// Step 3: find the arrows. Every source file is read with tree-sitter (parse.mjs); each import or
// type it uses is resolved to a file in the repo. Direction is data flow: from the file that is
// used to the file that uses it.

import { posix } from 'node:path';
import { familyOf, loadGrammars, parseFile } from './parse.mjs';

// Builds the arrows that involve at least one changed file, as [{ from, to, names }].
// `repoFiles` is the set of all file paths; `readFile(path)` returns a file's text or null.
export async function buildGraph(changedFiles, repoFiles, readFile) {
  const changed = new Set(changedFiles.map(f => f.path));
  // only languages that appear in the change are parsed
  const families = new Set(changedFiles.map(f => familyOf(f.path)).filter(Boolean));
  if (!families.size) return [];
  await loadGrammars(families);

  // shortcut: every file of those languages is parsed (~2 ms each, 16 s for 9,000 Java files);
  // pre-filter by the changed files' names if big repos need it faster
  const facts = new Map(); // path -> facts
  for (const path of repoFiles) {
    if (!families.has(familyOf(path))) continue;
    const source = readFile(path);
    const fileFacts = source == null ? null : parseFile(path, source);
    if (fileFacts) facts.set(path, fileFacts);
  }

  const ctx = { repoFiles, readFile, tsconfigs: new Map(), jvm: families.has('jvm') ? jvmIndex(facts) : null };
  const edges = new Map(); // one entry per (used, user) pair
  const add = (from, to, names) => {
    if (from === to || !(changed.has(from) || changed.has(to))) return;
    const key = `${from}\n${to}`; // file paths never contain a newline
    const edge = edges.get(key) ?? { from, to, names: new Set() };
    names.forEach(name => edge.names.add(name));
    edges.set(key, edge);
  };

  for (const [path, file] of facts) {
    if (file.lang === 'jvm') { jvmLinks(path, file, ctx.jvm, add); continue; }
    for (const imp of file.imports) {
      for (const target of resolve(path, imp, ctx)) add(target, path, imp.names);
    }
  }
  return [...edges.values()].map(edge => ({ ...edge, names: [...edge.names] }));
}

// Finds the repo file(s) one JS/TS or Python import points at. Returns [] for anything that is
// not a file in the repo (for example an npm package).
export function resolve(importingFile, imp, ctx) {
  const candidates = importingFile.endsWith('.py') ? pythonCandidates(importingFile, imp) : jsCandidates(importingFile, imp, ctx);
  // Each candidate group lists alternative spellings of one possible target; take the first that exists.
  return [...new Set(candidates.map(group => group.find(path => ctx.repoFiles.has(path))).filter(Boolean))];
}

// ---------------------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------------------

// What an import like './x' can point at: the file itself, with an extension, or a folder's index file.
const JS_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

function jsCandidates(importingFile, { spec }, ctx) {
  const bases = [];
  if (spec.startsWith('.')) bases.push(posix.join(posix.dirname(importingFile), spec));
  else {
    // not relative: maybe a tsconfig path alias (`@/app/x`) or a path from baseUrl; else a package
    const config = tsconfigFor(importingFile, ctx);
    for (const [pattern, targets] of config?.paths ?? []) {
      const star = pattern.indexOf('*');
      const matched = star < 0 ? (spec === pattern ? '' : null)
        : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1
          ? spec.slice(star, spec.length - (pattern.length - star - 1)) : null;
      if (matched != null) for (const target of targets) bases.push(posix.join(config.pathsBase, target.replace('*', matched)));
    }
    if (config?.baseUrl != null) bases.push(posix.join(config.baseUrl, spec));
  }
  return bases.flatMap(base => [
    JS_SUFFIXES.map(suffix => base + suffix),
    // TypeScript code often imports './x.js' for a file that is really './x.ts'
    JS_SUFFIXES.slice(1).map(suffix => base.replace(/\.[cm]?js$/, '') + suffix),
  ]);
}

// The nearest tsconfig.json / jsconfig.json above a file, with `extends` followed.
// Returns { paths: [[pattern, targets]], pathsBase, baseUrl } (repo-relative), or null.
function tsconfigFor(file, ctx) {
  let dir = posix.dirname(file);
  const seen = [];
  for (;;) {
    if (ctx.tsconfigs.has(dir)) break;
    seen.push(dir);
    const config = ['tsconfig.json', 'jsconfig.json'].map(name => posix.join(dir, name)).find(path => ctx.repoFiles.has(path));
    if (config) { ctx.tsconfigs.set(dir, loadTsconfig(config, ctx, 0)); break; }
    if (dir === '.' || dir === '') { ctx.tsconfigs.set(dir, null); break; }
    dir = posix.dirname(dir);
  }
  const found = ctx.tsconfigs.get(dir);
  for (const d of seen) ctx.tsconfigs.set(d, found);
  return found;
}

function loadTsconfig(path, ctx, depth) {
  let json;
  try { json = parseJsonc(ctx.readFile(path) ?? ''); } catch { return null; }
  const dir = posix.dirname(path);
  // the extended config first, so this one overrides it
  let result = { paths: null, pathsBase: dir, baseUrl: null };
  for (const parent of [json.extends ?? []].flat()) {
    // shortcut: configs extended from npm packages (`@tsconfig/node20`) are skipped; they rarely set paths
    if (depth > 10 || !parent.startsWith('.')) continue;
    const parentPath = posix.join(dir, parent.endsWith('.json') ? parent : parent + '.json');
    result = loadTsconfig(parentPath, ctx, depth + 1) ?? result;
  }
  const options = json.compilerOptions ?? {};
  if (options.baseUrl != null) result = { ...result, baseUrl: posix.join(dir, options.baseUrl), pathsBase: posix.join(dir, options.baseUrl) };
  if (options.paths) result = { ...result, paths: Object.entries(options.paths), pathsBase: result.baseUrl ?? dir };
  return result;
}

// JSON with comments and trailing commas, as tsconfig allows. Strings are kept intact,
// so a path like "src/*" is not mistaken for a comment.
export function parseJsonc(text) {
  // a string, a // comment, a /* */ comment, or a trailing comma; strings are kept as they are
  const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[}\]])/g, (match, string) => string ?? '');
  return JSON.parse(stripped);
}

// ---------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// Java / Kotlin: one index for both, since they call each other freely
// ---------------------------------------------------------------------------------------

// Which file declares which type:
//   byName:    'com.shop.Order' -> file
//   byPackage: 'com.shop' -> Map('Order' -> file)
//   types:     file -> its declared types (with supers, injects, beans)
//   providers: type file -> [{ file, name, beanName, primary, via }]  who can be injected for it
function jvmIndex(facts) {
  const index = { byName: new Map(), byPackage: new Map(), files: new Map(), providers: new Map() };
  for (const [path, file] of facts) {
    if (file.lang !== 'jvm') continue;
    index.files.set(path, file);
    const pkg = index.byPackage.get(file.package) ?? new Map();
    index.byPackage.set(file.package, pkg);
    for (const type of file.types) {
      index.byName.set(file.package ? `${file.package}.${type.name}` : type.name, path);
      if (!pkg.has(type.name)) pkg.set(type.name, path);
    }
  }
  // Implementations and @Bean methods, keyed by the file of the type they provide.
  for (const [path, file] of index.files) {
    const visible = jvmScope(path, file, index);
    for (const type of file.types) {
      if (type.kind === 'class') {
        const beanName = type.annotations.Qualifier || type.annotations.Component || type.annotations.Service || type.annotations.Repository
          || type.annotations.Controller || type.annotations.RestController || type.annotations.Named
          || type.name[0].toLowerCase() + type.name.slice(1);
        for (const parent of type.supers) {
          const target = visible.get(parent);
          if (target && target !== path) addProvider(index, target, { file: path, name: type.name, beanName, primary: 'Primary' in type.annotations, via: 'injected' });
        }
      }
      for (const bean of type.beans) {
        for (const name of bean.types) {
          addProvider(index, providerKey(visible, name), { file: path, name: `${type.name}.${bean.name}()`, beanName: bean.name, primary: bean.primary, via: '@Bean' });
        }
      }
    }
  }
  return index;
}

// Providers are keyed by the file declaring the type, or for types from outside the repo
// (java.time.Clock, RestTemplate) by their name.
// shortcut: two different outside types with the same simple name share a key; qualify by import if that bites
const providerKey = (scope, name) => scope.get(name) ?? 'type:' + name;

function addProvider(index, typeFile, provider) {
  index.providers.set(typeFile, [...(index.providers.get(typeFile) ?? []), provider]);
}

// The type names a file can use without spelling out the package, -> file:
// its own package, wildcard imports, explicit imports (also by alias).
function jvmScope(path, file, index) {
  if (file.scope) return file.scope;
  const scope = new Map(index.byPackage.get(file.package));
  for (const imp of file.imports) {
    if (imp.wildcard) for (const [name, target] of index.byPackage.get(imp.spec) ?? []) scope.set(name, target);
  }
  for (const imp of file.imports) {
    const target = !imp.wildcard && findJvmFile(imp.spec, index);
    if (target) scope.set(imp.alias ?? imp.spec.split('.').pop(), target);
  }
  scope.delete(undefined);
  file.scope = scope;
  return scope;
}

// 'com.shop.Order' or 'com.shop.Order.Inner' or a static member 'com.shop.Util.trim' -> file
function findJvmFile(name, index) {
  for (let parts = name.split('.'); parts.length; parts.pop()) {
    const file = index.byName.get(parts.join('.'));
    if (file) return file;
  }
  return null;
}

function jvmLinks(path, file, index, add) {
  const scope = jvmScope(path, file, index);
  // explicit imports always count, even if the name is not used again
  for (const imp of file.imports) {
    const target = !imp.wildcard && findJvmFile(imp.spec, index);
    if (target) add(target, path, [imp.alias ?? imp.spec.split('.').pop()]);
  }
  // same-package and wildcard-imported types are found by the names the code uses
  for (const name of file.uses) {
    const target = scope.get(name);
    if (target) add(target, path, [name]);
  }
  // Spring injection: the implementation (or @Bean method) that is handed over, not only the interface
  for (const type of file.types) {
    for (const { types, qualifier } of type.injects) {
      for (const name of types) {
        for (const provider of pickProviders(index.providers.get(providerKey(scope, name)) ?? [], qualifier, path)) {
          add(provider.file, path, [`${provider.name} (${provider.via})`]);
        }
      }
    }
  }
}

// Which candidates Spring would inject: the one named by @Qualifier, else the only one,
// else the @Primary one(s), else all of them (e.g. a List<Handler> takes every handler).
function pickProviders(candidates, qualifier, consumer) {
  const options = candidates.filter(c => c.file !== consumer);
  if (qualifier) {
    const named = options.filter(c => c.beanName === qualifier);
    if (named.length) return named;
  }
  if (options.length <= 1) return options;
  const primary = options.filter(c => c.primary);
  return primary.length ? primary : options;
}
