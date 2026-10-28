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

  const ctx = { repoFiles, readFile, tsconfigs: new Map() };
  // Java/Kotlin and C# find each other's types through a name index; Go through package folders
  const indexes = {};
  for (const lang of ['jvm', 'dotnet']) if (families.has(lang)) indexes[lang] = typeIndex(facts, lang);
  const go = families.has('go') ? goIndex(facts, repoFiles, readFile) : null;
  const c = families.has('c') ? cIndex(repoFiles) : null;
  const edges = new Map(); // one entry per (used, user) pair
  const add = (from, to, names) => {
    if (from === to || !(changed.has(from) || changed.has(to))) return;
    const key = `${from}\n${to}`; // file paths never contain a newline
    const edge = edges.get(key) ?? { from, to, names: new Set() };
    names.forEach(name => edge.names.add(name));
    edges.set(key, edge);
  };

  for (const [path, file] of facts) {
    if (indexes[file.lang]) { typeLinks(path, file, indexes[file.lang], add); continue; }
    if (file.lang === 'go') { goLinks(path, file, go, add); continue; }
    if (file.lang === 'c') { cLinks(path, file, c, add); continue; }
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
// Java / Kotlin (one index for both, since they call each other freely) and C#
// ---------------------------------------------------------------------------------------

// Which file declares which type, for one language family ('jvm' or 'dotnet'):
//   byName:    'com.shop.Order' -> file
//   byPackage: 'com.shop' -> Map('Order' -> file)   (C#: namespace)
//   files:     file -> its facts
//   providers: type file -> [{ file, name, beanName, primary, via }]  who can be injected for it
//   globals:   C# `global using` namespaces, visible in every file
// shortcut: a C# partial class spread over several files is indexed by its first file only
function typeIndex(facts, lang) {
  const index = { lang, byName: new Map(), byPackage: new Map(), files: new Map(), providers: new Map(), globals: [] };
  for (const [path, file] of facts) {
    if (file.lang !== lang) continue;
    index.files.set(path, file);
    for (const type of file.types) {
      const ns = type.ns ?? file.package;
      const pkg = index.byPackage.get(ns) ?? new Map();
      index.byPackage.set(ns, pkg);
      const full = ns ? `${ns}.${type.name}` : type.name;
      if (!index.byName.has(full)) index.byName.set(full, path);
      if (!pkg.has(type.name)) pkg.set(type.name, path);
    }
    index.globals.push(...file.imports.filter(imp => imp.global && imp.wildcard).map(imp => imp.spec));
  }
  // Implementations and @Bean methods, keyed by the file of the type they provide.
  for (const [path, file] of index.files) {
    const visible = typeScope(path, file, index);
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
  // C#: an implementation registered with services.AddScoped<I, Impl>() is the one injected for I
  for (const [path, file] of index.files) {
    const visible = typeScope(path, file, index);
    for (const [iface, impl] of file.registers ?? []) {
      for (const provider of index.providers.get(providerKey(visible, iface)) ?? []) {
        if (provider.file === visible.get(impl)) provider.primary = true;
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

// The type names a file can use without spelling out the package, -> file. Later entries win:
// wildcard imports (C#: `using` and `global using` namespaces), its own package (C#: also the
// namespaces around it), explicit imports (also by alias).
function typeScope(path, file, index) {
  if (file.scope) return file.scope;
  const scope = new Map();
  const addPackage = name => { for (const [type, target] of index.byPackage.get(name) ?? []) scope.set(type, target); };
  for (const imp of file.imports) if (imp.wildcard) addPackage(imp.spec);
  if (index.lang === 'dotnet') {
    index.globals.forEach(addPackage);
    // in namespace A.B.C the types of A, A.B and the global namespace are visible too
    const parts = file.package ? file.package.split('.') : [];
    for (let i = 0; i <= parts.length; i++) addPackage(parts.slice(0, i).join('.'));
  } else addPackage(file.package);
  for (const imp of file.imports) {
    const target = !imp.wildcard && findTypeFile(imp.spec, index);
    if (target) scope.set(imp.alias ?? imp.spec.split('.').pop(), target);
  }
  scope.delete(undefined);
  file.scope = scope;
  return scope;
}

// 'com.shop.Order' or 'com.shop.Order.Inner' or a static member 'com.shop.Util.trim' -> file
function findTypeFile(name, index) {
  for (let parts = name.split('.'); parts.length; parts.pop()) {
    const file = index.byName.get(parts.join('.'));
    if (file) return file;
  }
  return null;
}

function typeLinks(path, file, index, add) {
  const scope = typeScope(path, file, index);
  // explicit imports always count, even if the name is not used again
  for (const imp of file.imports) {
    const target = !imp.wildcard && findTypeFile(imp.spec, index);
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

// ---------------------------------------------------------------------------------------
// Go: an import names a folder of the module (go.mod); a package is all .go files in one folder
// ---------------------------------------------------------------------------------------

// modules: [[folder, module path]] from every go.mod; dirs: folder -> its .go files
function goIndex(facts, repoFiles, readFile) {
  const modules = [];
  for (const path of repoFiles) {
    if (posix.basename(path) !== 'go.mod') continue;
    const name = readFile(path)?.match(/^\s*module\s+"?([^\s"]+)/m)?.[1];
    if (name) modules.push([posix.dirname(path), name]);
  }
  const dirs = new Map();
  for (const [path, file] of facts) {
    if (file.lang === 'go') dirs.set(posix.dirname(path), [...(dirs.get(posix.dirname(path)) ?? []), path]);
  }
  return { modules, dirs, facts };
}

// Links a Go file to the files that declare what it uses: from its own package by name, and from
// imported packages by `pkg.Name`. An import whose names are not found (or `import _`) links
// the whole package.
function goLinks(path, file, go, add) {
  const declared = target => go.facts.get(target).types.map(type => type.name);
  const here = posix.dirname(path);
  for (const sibling of go.dirs.get(here) ?? []) {
    if (sibling === path || go.facts.get(sibling).package !== file.package) continue;
    const names = declared(sibling).filter(name => file.uses.has(name));
    if (names.length) add(sibling, path, names);
  }
  for (const imp of file.imports) {
    // the longest module path that the import starts with
    const [dir, module] = go.modules.filter(([, m]) => imp.spec === m || imp.spec.startsWith(m + '/'))
      .sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (module == null) continue; // standard library or another module
    const targets = (go.dirs.get(posix.join(dir, imp.spec.slice(module.length + 1))) ?? []).filter(p => !p.endsWith('_test.go'));
    if (!targets.length) continue;
    const name = imp.alias ?? go.facts.get(targets[0]).package;
    let linked = false;
    for (const target of targets) {
      const names = declared(target).map(n => (name === '.' ? n : `${name}.${n}`)).filter(n => file.uses.has(n));
      if (names.length) { add(target, path, names); linked = true; }
    }
    if (!linked) for (const target of targets) add(target, path, []);
  }
}

// ---------------------------------------------------------------------------------------
// C / C++: #include "x.h"; a .c / .cpp file including its same-named header is labelled "implements"
// ---------------------------------------------------------------------------------------

const C_HEADER = /\.(?:h|hh|hpp|hxx|h\+\+)$/i;
const C_SOURCE = /\.(?:c|cc|cpp|cxx|c\+\+)$/i;
const stem = path => posix.basename(path).replace(/\.[^.]+$/, '');

// file name -> every repo file with that name, to find an include under any include folder
function cIndex(repoFiles) {
  const byName = new Map();
  for (const path of repoFiles) {
    const name = posix.basename(path);
    if (byName.has(name)) byName.get(name).push(path); else byName.set(name, [path]);
  }
  return { byName, repoFiles };
}

// "x.h" is looked up next to the including file first, as the compiler does. Otherwise (and for <x.h>)
// any repo file whose path ends in x.h counts, since the -I folders are unknown; the one closest to
// the including file wins. <vector> and other system headers match nothing in the repo.
// shortcut: compile_commands.json / CMake include folders are not read; read them if the guess picks wrong files
function cLinks(path, file, c, add) {
  // src/foo.c including include/foo.h implements it
  const label = target => (C_SOURCE.test(path) && C_HEADER.test(target) && stem(target) === stem(path) ? ['implements'] : []);
  for (const imp of file.imports) {
    const here = posix.join(posix.dirname(path), imp.spec);
    if (!imp.system && c.repoFiles.has(here)) { add(here, path, label(here)); continue; }
    const wanted = posix.normalize(imp.spec).replace(/^(?:\.\.?\/)+/, '');
    const found = (c.byName.get(posix.basename(wanted)) ?? []).filter(p => p === wanted || p.endsWith('/' + wanted));
    const shared = p => { let i = 0; const a = p.split('/'), b = path.split('/'); while (i < a.length - 1 && a[i] === b[i]) i++; return i; };
    const best = Math.max(...found.map(shared));
    for (const target of found) if (shared(target) === best) add(target, path, label(target));
  }
}
