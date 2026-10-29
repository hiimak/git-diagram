// Reads one source file with tree-sitter and returns the facts the graph needs, the same shape
// for every language:
//   { lang, package, imports, types, uses }
//   package: 'com.shop.web' (Java/Kotlin), 'Shop.Web' (C# namespace), 'store' (Go), '' otherwise
//   imports: [{ spec, names, wildcard, alias, global }]   spec is what the file wrote: './db', '.models',
//            'com.shop.Order', 'Shop.Data' (C# using), 'example.com/shop/store' (Go)
//   types:   classes / interfaces declared in the file (Java/Kotlin/C#), each
//            { name, ns, kind, supers, annotations, injects, beans }
//              ns:          C# only: the namespace of this type, when a file has more than one
//              kind:        'class' | 'interface' | 'abstract'
//              supers:      names it extends / implements
//              annotations: { Service: '', Qualifier: 'fast' }  (annotation name -> first string argument)
//              injects:     [{ types, qualifier }]  what DI hands it (constructor, @Autowired, @Bean params)
//              beans:       [{ types, name, primary }]  what its @Bean methods return
//            Go: every top-level func, type, var and const, as { name }
//   uses:    names used in the code, for types that need no import: capitalised names (Java/Kotlin/C#),
//            every name plus 'pkg.Name' for qualified ones (Go)
//   registers: C# only: [[interface, implementation]] from services.AddScoped<I, Impl>() and friends
//   C / C++: only imports, one per #include, with spec 'net/socket.h' and system: true for <...>
//   Bash, PowerShell, Dockerfile, docker-compose: only imports, one per file path the file names, with
//            spec 'lib/common.sh' (relative to the file's folder), names ['source'] (what it does with the
//            file: 'source', 'runs', 'COPY', 'build'...), folder: true when every file under a folder counts,
//            and here: true when the path is only read from the file's folder, never the repository root

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { Parser, Language } from 'web-tree-sitter';

// file extension -> grammar (grammars/tree-sitter-<name>.wasm)
const GRAMMAR = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  cs: 'c_sharp', go: 'go',
  // a .h may be C or C++; the C++ grammar reads both well enough for #include lines
  sh: 'bash', bash: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', 'h++': 'cpp', ipp: 'cpp', tpp: 'cpp', inl: 'cpp',
};

// Languages that resolve imports the same way and can see each other's files.
const FAMILY = { javascript: 'js', typescript: 'js', tsx: 'js', python: 'python', java: 'jvm', kotlin: 'jvm', c_sharp: 'dotnet', go: 'go', c: 'c', cpp: 'c',
  bash: 'script', powershell: 'script', yaml: 'script', dockerfile: 'script' };

// Dockerfile, Dockerfile.dev, api.Dockerfile, Containerfile; docker-compose.yml, compose.prod.yaml
const DOCKERFILE = /^(?:docker|container)file(?:\.[\w.-]+)?$|\.(?:docker|container)file$/;
const NOT_A_DOCKERFILE = /\.(?:md|txt|rst|html?|json|ya?ml)$/; // Dockerfile.md documents one
const COMPOSE = /^(?:docker-)?compose(?:\.[\w-]+)*\.ya?ml$/;

// `source` is only needed for a file without extension: a script is known by its `#!` line
export function grammarOf(path, source) {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (DOCKERFILE.test(name) && !NOT_A_DOCKERFILE.test(name)) return 'dockerfile';
  if (COMPOSE.test(name)) return 'yaml';
  if (name.includes('.')) return GRAMMAR[name.slice(name.lastIndexOf('.') + 1)];
  const shell = source?.match(/^#![^\n]*?\b(pwsh|powershell|bash|zsh|ksh|dash|sh)\b/)?.[1];
  return shell && (shell[0] === 'p' ? 'powershell' : 'bash');
}

export const familyOf = (path, source) => FAMILY[grammarOf(path, source)];

const parsers = new Map(); // grammar -> Parser, filled by loadGrammars

// Loads the grammars for the given families. A grammar that fails to load is reported once
// and its files simply get no arrows.
export async function loadGrammars(families) {
  await Parser.init();
  for (const [grammar, family] of Object.entries(FAMILY)) {
    if (!families.has(family) || parsers.has(grammar) || grammar === 'dockerfile') continue;
    try {
      const language = await Language.load(readFileSync(new URL(`../grammars/tree-sitter-${grammar}.wasm`, import.meta.url)));
      const parser = new Parser();
      parser.setLanguage(language);
      parsers.set(grammar, parser);
    } catch (e) {
      console.warn(`git diagram: could not load the ${grammar} grammar (${e.message}); its files get no arrows`);
      parsers.set(grammar, null);
    }
  }
}

// Returns the facts for one file, or null if its language is unknown or not loaded.
// Files with syntax errors still parse; whatever tree-sitter could read is used.
export function parseFile(path, source) {
  const grammar = grammarOf(path, source);
  const facts = { lang: FAMILY[grammar], package: '', imports: [], types: [], uses: new Set() };
  // no Dockerfile grammar is published on npm; its instructions are one per line, so read the lines
  if (grammar === 'dockerfile') { readDockerfile(source, facts); return facts; }
  const parser = parsers.get(grammar);
  if (!parser) return null;
  // tree-sitter-bash 0.25 reads a line starting with `\` (`\. lib.sh`, which skips aliases) as part of
  // the line before; the backslash changes nothing else, so it is dropped
  const tree = parser.parse(grammar === 'bash' ? source.replace(/^([ \t]*)\\(?=[.\w])/gm, '$1') : source);
  try {
    (READERS[grammar] ?? READERS[FAMILY[grammar]])(tree.rootNode, facts);
    return facts;
  } finally {
    tree.delete(); // trees live in WebAssembly memory, not freed by the garbage collector
  }
}

const READERS = {
  js: readJs, python: readPython, dotnet: readCsharp, go: readGo, c: readC,
  bash: readBash, powershell: readPowershell, yaml: readCompose,
  jvm: (root, facts) => (root.type === 'program' ? readJava : readKotlin)(root, facts),
};

// ---------------------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------------------

function readJs(root, facts) {
  for (const node of root.descendantsOfType(['import_statement', 'export_statement', 'call_expression'])) {
    if (node.type === 'call_expression') {
      // require('./x') and import('./x')
      const callee = node.childForFieldName('function');
      const arg = node.childForFieldName('arguments')?.namedChildren[0];
      if ((callee?.text === 'require' || callee?.type === 'import') && arg?.type === 'string') facts.imports.push({ spec: stringValue(arg), names: [] });
      continue;
    }
    const source = node.childForFieldName('source');
    if (!source) continue; // a plain `export const x`, no other file involved
    const names = [];
    // import a, { b as c } from   import * as ns from   export { a } from   export * from
    const clause = node.namedChildren.find(n => n.type === 'import_clause' || n.type === 'export_clause');
    for (const part of clause?.type === 'import_clause' ? clause.namedChildren : clause ? [clause] : []) {
      if (part.type === 'identifier') names.push(part.text); // default import
      else if (part.type === 'namespace_import') names.push('*');
      else for (const spec of part.namedChildren) names.push(spec.childForFieldName('name').text);
    }
    if (!clause && node.type === 'export_statement') names.push('*');
    facts.imports.push({ spec: stringValue(source), names });
  }
}

const stringValue = node => node.text.slice(1, -1);

// ---------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------

function readPython(root, facts) {
  for (const node of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (node.type === 'import_statement') {
      // import a.b, c as d
      for (const name of node.childrenForFieldName('name')) facts.imports.push({ spec: (name.childForFieldName('name') ?? name).text, names: [] });
    } else {
      // from ..core.models import User, Order
      const names = node.childrenForFieldName('name').map(name => (name.childForFieldName('name') ?? name).text);
      facts.imports.push({ spec: node.childForFieldName('module_name').text, names });
    }
  }
}

// ---------------------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------------------

const JAVA_TYPES = ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration'];

function readJava(root, facts) {
  for (const node of root.namedChildren) {
    if (node.type === 'package_declaration') facts.package = node.namedChildren[0].text;
    else if (node.type === 'import_declaration') {
      // `import static a.b.C.m;` `import a.b.*;`
      const path = node.namedChildren.find(n => n.type !== 'asterisk');
      facts.imports.push({ spec: path.text, names: [], wildcard: node.namedChildren.some(n => n.type === 'asterisk') });
    } else collectUses(node, ['identifier', 'type_identifier'], facts.uses);
  }
  for (const node of root.descendantsOfType(JAVA_TYPES)) facts.types.push(readJavaType(node));
}

function readJavaType(node) {
  const modifiers = node.namedChildren.find(n => n.type === 'modifiers');
  const annotations = javaAnnotations(modifiers);
  const kind = node.type === 'interface_declaration' || node.type === 'annotation_type_declaration' ? 'interface'
    : /\babstract\b/.test(modifiers?.text ?? '') ? 'abstract' : 'class';
  const supers = [];
  for (const field of ['superclass', 'interfaces']) {
    const part = node.childForFieldName(field);
    if (part) supers.push(...outerTypes(part));
  }
  for (const part of node.namedChildren.filter(n => n.type === 'extends_interfaces')) supers.push(...outerTypes(part));

  const type = { name: node.childForFieldName('name').text, kind, supers, annotations, injects: [], beans: [] };
  const body = node.childForFieldName('body');
  const managed = isSpringManaged(annotations);
  const lombokAll = 'AllArgsConstructor' in annotations, lombokFinal = 'RequiredArgsConstructor' in annotations;
  for (const member of body?.namedChildren ?? []) {
    const memberAnnotations = javaAnnotations(member.namedChildren.find(n => n.type === 'modifiers'));
    const mods = member.namedChildren.find(n => n.type === 'modifiers')?.text ?? '';
    if (member.type === 'field_declaration') {
      const viaLombok = managed && !/\bstatic\b/.test(mods) && (lombokAll || (lombokFinal && /\bfinal\b/.test(mods)));
      if (INJECT.some(a => a in memberAnnotations) || viaLombok) type.injects.push(injection(member.childForFieldName('type'), memberAnnotations));
    } else if (member.type === 'constructor_declaration' || member.type === 'method_declaration') {
      const isBean = member.type === 'method_declaration' && 'Bean' in memberAnnotations;
      const injected = isBean || INJECT.some(a => a in memberAnnotations) || (member.type === 'constructor_declaration' && managed);
      if (injected) {
        for (const param of member.childForFieldName('parameters')?.namedChildren ?? []) {
          if (param.type === 'formal_parameter') type.injects.push(injection(param.childForFieldName('type'), javaAnnotations(param.namedChildren.find(n => n.type === 'modifiers'))));
        }
      }
      if (isBean) type.beans.push({ types: typeNames(member.childForFieldName('type')), name: memberAnnotations.Bean || member.childForFieldName('name').text, primary: 'Primary' in memberAnnotations });
    }
  }
  return type;
}

// modifiers node -> { AnnotationName: 'first string argument' }
function javaAnnotations(modifiers) {
  const out = {};
  for (const a of modifiers?.namedChildren ?? []) {
    if (a.type !== 'marker_annotation' && a.type !== 'annotation') continue;
    const name = a.childForFieldName('name').text.split('.').pop();
    out[name] = a.childForFieldName('arguments')?.descendantsOfType('string_fragment')[0]?.text ?? '';
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------------------

function readKotlin(root, facts) {
  for (const node of root.namedChildren) {
    if (node.type === 'package_header') facts.package = node.namedChildren[0].text;
    else if (node.type === 'import') {
      // import a.b.C   import a.b.*   import a.b.C as D
      const [path, alias] = node.namedChildren;
      facts.imports.push({ spec: path.text, names: [], wildcard: /\*\s*$/.test(node.text), alias: alias?.text });
    } else {
      collectUses(node, ['identifier'], facts.uses);
      // top-level functions and properties can be imported too: index them like types
      if (node.type === 'function_declaration' || node.type === 'property_declaration') {
        const name = node.childForFieldName('name') ?? node.descendantsOfType('variable_declaration')[0]?.namedChildren[0];
        if (name) facts.types.push({ name: name.text, kind: 'member', supers: [], annotations: {}, injects: [], beans: [] });
      }
    }
  }
  for (const node of root.descendantsOfType(['class_declaration', 'object_declaration'])) facts.types.push(readKotlinType(node));
  for (const node of root.descendantsOfType('type_alias')) {
    const name = node.childForFieldName('type');
    if (name) facts.types.push({ name: name.text, kind: 'class', supers: [], annotations: {}, injects: [], beans: [] });
  }
}

function readKotlinType(node) {
  const modifiers = node.namedChildren.find(n => n.type === 'modifiers');
  const annotations = kotlinAnnotations(modifiers);
  const keyword = node.children.find(n => !n.isNamed && (n.type === 'interface' || n.type === 'class' || n.type === 'object'))?.type;
  const kind = keyword === 'interface' ? 'interface' : /\b(?:abstract|sealed)\b/.test(modifiers?.text ?? '') ? 'abstract' : 'class';
  const supers = node.namedChildren.filter(n => n.type === 'delegation_specifiers')
    .flatMap(d => d.namedChildren).map(spec => spec.descendantsOfType('user_type')[0]?.namedChildren[0]?.text).filter(Boolean);

  const type = { name: node.childForFieldName('name').text, kind, supers, annotations, injects: [], beans: [] };
  const managed = isSpringManaged(annotations);
  for (const ctor of node.namedChildren.filter(n => n.type === 'primary_constructor')) {
    if (!managed && !INJECT.some(a => a in kotlinAnnotations(ctor.namedChildren.find(n => n.type === 'modifiers')))) continue;
    for (const param of ctor.descendantsOfType('class_parameter')) type.injects.push(injection(param.namedChildren.find(n => n.type.endsWith('_type')), kotlinAnnotations(param.namedChildren.find(n => n.type === 'modifiers'))));
  }
  const body = node.namedChildren.find(n => n.type === 'class_body');
  for (const member of body?.namedChildren ?? []) {
    const memberAnnotations = kotlinAnnotations(member.namedChildren.find(n => n.type === 'modifiers'));
    if (member.type === 'property_declaration' && INJECT.some(a => a in memberAnnotations)) {
      type.injects.push(injection(member.descendantsOfType('variable_declaration')[0]?.namedChildren.find(n => n.type.endsWith('_type')), memberAnnotations));
    } else if (member.type === 'function_declaration' && ('Bean' in memberAnnotations || INJECT.some(a => a in memberAnnotations))) {
      for (const param of member.namedChildren.find(n => n.type === 'function_value_parameters')?.namedChildren ?? []) {
        if (param.type === 'parameter') type.injects.push(injection(param.namedChildren.find(n => n.type.endsWith('_type')), memberAnnotations));
      }
      // the return type is the direct type child after the parameters
      const returns = member.namedChildren.find(n => n.type.endsWith('_type'));
      if ('Bean' in memberAnnotations && returns) type.beans.push({ types: typeNames(returns), name: memberAnnotations.Bean || member.childForFieldName('name').text, primary: 'Primary' in memberAnnotations });
    }
  }
  return type;
}

function kotlinAnnotations(modifiers) {
  const out = {};
  for (const a of modifiers?.namedChildren ?? []) {
    if (a.type !== 'annotation') continue;
    const name = a.descendantsOfType('user_type')[0]?.namedChildren.filter(n => n.type === 'identifier').pop()?.text;
    if (name) out[name] = a.descendantsOfType('string_content')[0]?.text ?? '';
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------------------

const CS_TYPES = ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration', 'delegate_declaration'];
// services.AddScoped<IPayment, CardPayment>(), also TryAdd… and AddKeyed…
const CS_REGISTER = /^(?:Try)?Add(?:Keyed)?(?:Scoped|Transient|Singleton)$/;

function readCsharp(root, facts) {
  for (const node of root.descendantsOfType('using_directive')) {
    // using A.B;   using static A.B.C;   using X = A.B.C;   global using A.B;
    const alias = node.childForFieldName('name');
    const path = node.namedChildren.find(n => n.id !== alias?.id);
    if (!path) continue;
    const isStatic = node.children.some(n => n.type === 'static');
    facts.imports.push({ spec: path.text, names: [], wildcard: !alias && !isStatic, alias: alias?.text, global: node.children.some(n => n.type === 'global') });
  }
  facts.package = root.namedChildren.find(n => n.type === 'file_scoped_namespace_declaration')?.childForFieldName('name').text
    ?? root.descendantsOfType('namespace_declaration')[0]?.childForFieldName('name').text ?? '';
  for (const node of root.descendantsOfType(CS_TYPES)) facts.types.push(readCsharpType(node, facts.package));
  facts.registers = [];
  for (const node of root.descendantsOfType('generic_name')) {
    const args = node.namedChildren.find(n => n.type === 'type_argument_list')?.namedChildren ?? [];
    if (CS_REGISTER.test(node.namedChildren[0].text) && args.length === 2) facts.registers.push(args.map(csName));
  }
  // names used outside `using` lines and namespace names
  const collect = node => {
    for (const n of node?.namedChildren ?? []) {
      if (n.type === 'using_directive' || n.type === 'file_scoped_namespace_declaration') continue;
      if (n.type === 'namespace_declaration') collect(n.childForFieldName('body'));
      else collectUses(n, ['identifier'], facts.uses);
    }
  };
  collect(root);
}

function readCsharpType(node, fileNamespace) {
  // the namespace blocks around it, innermost last; a file-scoped namespace has no block
  const blocks = [];
  for (let n = node.parent; n; n = n.parent) if (n.type === 'namespace_declaration') blocks.unshift(n.childForFieldName('name').text);
  const ns = blocks.length ? blocks.join('.') : fileNamespace;
  const modifiers = node.namedChildren.filter(n => n.type === 'modifier').map(n => n.text);
  const kind = node.type === 'interface_declaration' ? 'interface' : modifiers.includes('abstract') ? 'abstract' : 'class';
  const supers = node.namedChildren.find(n => n.type === 'base_list')?.namedChildren.map(csName).filter(Boolean) ?? [];
  const type = { name: node.childForFieldName('name').text, ns, kind, supers, annotations: csAttributes(node), injects: [], beans: [] };
  if (node.type !== 'class_declaration' && node.type !== 'struct_declaration') return type; // records hold data, not services
  // ASP.NET Core injects through constructors (also C# 12 primary constructors) and Blazor [Inject] properties
  const params = [node.namedChildren.find(n => n.type === 'parameter_list')];
  const body = node.childForFieldName('body');
  for (const member of body?.namedChildren ?? []) {
    if (member.type === 'constructor_declaration') params.push(member.childForFieldName('parameters'));
    else if (member.type === 'property_declaration' && 'Inject' in csAttributes(member)) type.injects.push({ types: typeNames(member.childForFieldName('type')), qualifier: '' });
  }
  for (const param of params.flatMap(list => list?.namedChildren ?? [])) {
    if (param.type === 'parameter') type.injects.push({ types: typeNames(param.childForFieldName('type')), qualifier: '' });
  }
  return type;
}

// `Order`, `IRepo<Order>`, `Shop.Data.Order` -> 'Order', 'IRepo', 'Order'
function csName(node) {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'generic_name') return node.namedChildren[0].text;
  if (node.type === 'qualified_name') return csName(node.childForFieldName('name'));
  return null;
}

// [ApiController, Route("x")] -> { ApiController: '', Route: 'x' }
function csAttributes(node) {
  const out = {};
  for (const list of node.namedChildren.filter(n => n.type === 'attribute_list')) {
    for (const a of list.namedChildren) {
      const name = a.childForFieldName('name')?.text.split('.').pop().replace(/Attribute$/, '');
      if (name) out[name] = a.descendantsOfType('string_literal_content')[0]?.text ?? '';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------------------

function readGo(root, facts) {
  for (const node of root.namedChildren) {
    if (node.type === 'package_clause') { facts.package = node.namedChildren[0].text; continue; }
    if (node.type === 'import_declaration') {
      // import "a/b"   import x "a/b"   import . "a/b"   import _ "a/b"
      for (const spec of node.descendantsOfType('import_spec')) {
        facts.imports.push({ spec: spec.childForFieldName('path').text.slice(1, -1), names: [], alias: spec.childForFieldName('name')?.text });
      }
      continue;
    }
    // what this file declares for the rest of its package (methods hang off their type)
    const names = node.type === 'function_declaration' ? [node.childForFieldName('name')]
      : node.type === 'type_declaration' ? node.namedChildren.map(spec => spec.childForFieldName('name'))
      : node.type === 'var_declaration' || node.type === 'const_declaration' ? node.descendantsOfType(['var_spec', 'const_spec']).flatMap(spec => spec.childrenForFieldName('name'))
      : [];
    // every file may have its own init(), and `_` is no name: neither connects files
    for (const name of names) if (name && name.text !== 'init' && name.text !== '_') facts.types.push({ name: name.text });
    for (const n of node.descendantsOfType(['identifier', 'type_identifier'])) facts.uses.add(n.text);
    for (const n of node.descendantsOfType('selector_expression')) {
      const operand = n.childForFieldName('operand');
      if (operand.type === 'identifier') facts.uses.add(`${operand.text}.${n.childForFieldName('field').text}`);
    }
    for (const n of node.descendantsOfType('qualified_type')) facts.uses.add(`${n.childForFieldName('package').text}.${n.childForFieldName('name').text}`);
  }
}

// ---------------------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------------------

function readC(root, facts) {
  // #include "net/socket.h"   #include <vector>   (also inside #if blocks)
  for (const node of root.descendantsOfType('preproc_include')) {
    const path = node.childForFieldName('path');
    if (path?.type === 'string_literal') facts.imports.push({ spec: path.text.slice(1, -1), names: [] });
    else if (path?.type === 'system_lib_string') facts.imports.push({ spec: path.text.slice(1, -1), names: [], system: true });
  }
}

// ---------------------------------------------------------------------------------------
// Bash, PowerShell, Dockerfile, docker-compose: files named by their path
// ---------------------------------------------------------------------------------------

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
// commands that run the command after them: `exec ./x.sh`, `sudo -E ./install.sh`
const WRAPPERS = new Set(['exec', 'sudo', 'nohup', 'time', 'command', 'xargs']);
// stands for the repository root in a path, until scriptPath turns it into a leading `/`
const ROOT = '\0';

// stands for the script file itself; no path contains it, so only a following `/..` makes it usable
const SELF = './\u0001';

// Replaces what a shell path says about folders, so `"$(cd "$(dirname "$0")/.." && pwd)"/lib/x.sh`
// becomes `./\u0001/../../lib/x.sh` (= ../lib/x.sh): `$0` and `$BASH_SOURCE` are the script itself,
// `$(dirname X)` and `${X%/*}` X's folder, `$(git rev-parse --show-toplevel)` the repository root,
// `$(cd X && pwd)` and `$(realpath X)` are X, and `$NAME` / `${NAME}` the value of a variable set
// earlier in the file. Repeated until nothing changes, for `$(dirname "$(dirname "$0")")`.
function shellExpand(text, vars) {
  let path = text.replace(/["']/g, '');
  for (let before; before !== path;) {
    before = path;
    path = path
      .replace(/\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`/g, ROOT)
      .replace(/\$\{(?:BASH_SOURCE(?:\[0\])?|0)%\/\*\}/g, SELF + '/..')
      .replace(/\$\{(?:BASH_SOURCE(?:\[0\])?|0)\}|\$BASH_SOURCE(?:\[0\])?|\$0(?!\w)/g, SELF)
      .replace(/\$\(\s*dirname\s+(?:--\s+)?([^\s()$`]+)\s*\)|`\s*dirname\s+(?:--\s+)?([^\s()$`]+)\s*`/g, (m, a, b) => `${a ?? b}/..`)
      .replace(/\$\(\s*cd\s+(?:-\S+\s+)*([^\s()&;|$]+)\s*(?:>\s*\/dev\/null\s*)?(?:&&|;)\s*\\?pwd(?:\s+-[PL])?\s*\)/g, '$1')
      .replace(/\$\(\s*(?:realpath|readlink\s+-[a-z]+)\s+([^\s()$]+)\s*\)/g, '$1')
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (match, a, b) => vars.get(a ?? b) ?? match);
  }
  return path;
}

function readBash(root, facts) {
  // ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)": variables that name a folder
  const vars = new Map();
  // in file order, so a variable has the value it was last given above the line that uses it
  for (const cmd of root.descendantsOfType(['variable_assignment', 'command'])) {
    if (cmd.type === 'variable_assignment') {
      const value = cmd.childForFieldName('value')?.text ?? '';
      if (value.includes('\n')) continue; // a path is one line
      // kept unnormalised, so a root-based value (\0) can still start a longer path
      const path = shellExpand(value, vars);
      if (scriptPath(path)) vars.set(cmd.childForFieldName('name').text, path);
      // a folder built with a helper this file defines (`$(my_cd "$(dirname "$0")" && pwd)`) is taken
      // to be the script's own folder
      else if (/\$\(\s*dirname\s|BASH_SOURCE/.test(value)) vars.set(cmd.childForFieldName('name').text, '.');
      continue;
    }
    // source lib.sh   . ./lib.sh   bash scripts/x.sh   ./build.sh   exec ./x.sh   (\. skips aliases)
    let words = [cmd.childForFieldName('name'), ...cmd.childrenForFieldName('argument')].filter(Boolean).map(n => n.text.replace(/^\\/, ''));
    while (WRAPPERS.has(words[0])) {
      words = words.slice(1);
      while (words[0]?.startsWith('-')) words = words.slice(1);
    }
    const [name = '', ...args] = words;
    const [label, target] = name === 'source' || name === '.' ? ['source', args[0]]
      : SHELLS.has(name) && !args.includes('-c') ? ['runs', args.find(a => !a.startsWith('-'))]
      : name.includes('/') ? ['runs', name] : [];
    const spec = target && scriptPath(shellExpand(target, vars));
    if (spec) facts.imports.push({ spec, names: [label] });
  }
}

// Same for PowerShell: `$PSScriptRoot` is the script's folder, `$PSCommandPath` and
// `$MyInvocation.MyCommand.Path` the script itself, `Split-Path X` X's folder,
// `Join-Path X Y` X/Y, and `$name` the value of a variable set earlier.
function psExpand(text, vars) {
  let path = text.replace(/["']/g, '');
  for (let before; before !== path;) {
    before = path;
    path = path
      .replace(/\$?\(\s*git\s+rev-parse\s+--show-toplevel\s*\)/gi, ROOT)
      .replace(/\$\{?PSScriptRoot\}?/gi, '.')
      .replace(/\$\{?PSCommandPath\}?|\$MyInvocation\.MyCommand\.(?:Path|Definition)/gi, SELF)
      .replace(/^\s*\$?\(?\s*Split-Path\s+(?:-Parent\s+)?(?:-Path\s+)?([^\s()]+)(?:\s+-Parent)?\s*\)?\s*$/i, '$1/..')
      .replace(/\$?\(\s*Split-Path\s+(?:-Parent\s+)?(?:-Path\s+)?([^\s()]+)(?:\s+-Parent)?\s*\)/gi, '$1/..')
      .replace(/^\s*\$?\(?\s*Join-Path\s+(?:-Path\s+)?([^\s()]+)\s+(?:-ChildPath\s+)?([^\s()]+)\s*\)?\s*$/i, '$1/$2')
      .replace(/\$?\(\s*Join-Path\s+(?:-Path\s+)?([^\s()]+)\s+(?:-ChildPath\s+)?([^\s()]+)\s*\)/gi, '$1/$2')
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (match, a, b) => vars.get((a ?? b).toLowerCase()) ?? match);
  }
  return path;
}

// module manifest keys that name files of the module
const PS_MANIFEST = /^(?:RootModule|ModuleToProcess|NestedModules|ScriptsToProcess|TypesToProcess|FormatsToProcess)$/i;

function readPowershell(root, facts) {
  // $here = Split-Path -Parent $MyInvocation.MyCommand.Path   (PowerShell names ignore case)
  const vars = new Map();
  const push = (label, target) => {
    const spec = target && scriptPath(psExpand(target, vars));
    if (!spec) return;
    // Import-Module ./Store loads the folder's manifest or module file
    if (label === 'Import-Module' && !/\.ps[dm]?1$/i.test(spec)) {
      const base = posix.basename(spec);
      facts.imports.push({ spec: `${spec}/${base}.psd1`, names: [label] }, { spec: `${spec}/${base}.psm1`, names: [label] });
    } else facts.imports.push({ spec, names: [label] });
  };
  // in file order, so a variable has the value it was last given above the line that uses it
  for (const cmd of root.descendantsOfType(['assignment_expression', 'command'])) {
    if (cmd.type === 'assignment_expression') {
      // a path is one line; script blocks and hashtables are skipped
      const [, name, value] = cmd.text.match(/^\$(\w+)\s*=\s*([^\n]*)$/) ?? [];
      const path = name && psExpand(value, vars);
      if (path && scriptPath(path)) vars.set(name.toLowerCase(), path);
      continue;
    }
    // . .\lib.ps1   & .\build.ps1   .\run.ps1   Import-Module ./Store   using module ./Store.psm1
    const op = cmd.namedChildren.find(n => n.type === 'command_invokation_operator')?.text;
    const name = cmd.namedChildren.find(n => n.type === 'command_name' || n.type === 'command_name_expr')?.text ?? '';
    const args = cmd.namedChildren.find(n => n.type === 'command_elements')?.namedChildren
      .filter(n => n.type !== 'command_argument_sep' && n.type !== 'command_parameter').map(n => n.text) ?? [];
    if (op === '.') push('dot-source', name);
    else if (op === '&' || /[\\/]/.test(name)) push('runs', name);
    else if (/^(?:Import-Module|ipmo)$/i.test(name)) push('Import-Module', args[0]);
    else if (/^using$/i.test(name) && /^module$/i.test(args[0])) push('using module', args[1]);
  }
  // .psd1: @{ RootModule = 'Store.psm1'; NestedModules = @('a.psm1') }
  for (const entry of root.descendantsOfType('hash_entry')) {
    const [key, value] = entry.namedChildren;
    if (!PS_MANIFEST.test(key?.text ?? '')) continue;
    for (const s of value?.descendantsOfType('string_literal') ?? []) push('module', s.text);
  }
}

// Cleans an expanded path: `\` becomes `/`, `./lib/../x.sh` becomes `x.sh`, and a path from the
// repository root starts with `/`. Returns null for what cannot be followed: a variable left over,
// a glob, an absolute path, a home folder, a URL.
function scriptPath(text) {
  let path = text.replace(/["']/g, '').replace(/\\/g, '/');
  if (!path || /^(?:\/|~|[a-z]+:)/i.test(path)) return null;
  const fromRoot = path.startsWith(ROOT);
  path = posix.normalize(fromRoot ? path.slice(1).replace(/^\/+/, '') : path);
  if (/[$`*?(){}<>|;&\s\0\u0001]/.test(path)) return null;
  return fromRoot ? '/' + path : path;
}

// What a Dockerfile copies into the image and the scripts it runs.
const RUNNABLE = /(?:^|[\s"'[,=])((?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:sh|bash|ps1|py|js|mjs|cjs|rb|pl))(?=$|[\s"',\]])/g;

function readDockerfile(source, facts) {
  // `\` at a line end continues the instruction; comment lines inside it are dropped
  const lines = source.replace(/\\[ \t]*\r?\n(?:[ \t]*#.*\r?\n)*/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const [, op, rest] = line.match(/^\s*(COPY|ADD|RUN|CMD|ENTRYPOINT)\s+(.*)$/i) ?? [];
    if (!op) continue;
    if (/^(?:COPY|ADD)$/i.test(op)) {
      // COPY --chown=app src/ ./   COPY ["a b.json", "./"]; --from copies out of another image, <<EOF is inline
      if (/--from[= ]|<</i.test(rest)) continue;
      const args = rest.replace(/--[\w-]+(?:=\S*)?\s+/g, '').trim();
      let parts;
      try { parts = args.startsWith('[') ? JSON.parse(args) : args.split(/\s+/); } catch { continue; }
      for (const src of parts.slice(0, -1)) {
        if (/^[a-z]+:\/\/|^\$/i.test(src)) continue; // ADD https://…, COPY $SRC
        const path = posix.normalize(src.replace(/\\/g, '/')).replace(/\/+$/, ''); // Windows images write .\app
        // the whole build context (`COPY . .`) would point every file at the Dockerfile and say nothing
        if (!path || path === '.' || path === '*') continue;
        facts.imports.push({ spec: path, names: [op.toUpperCase()], folder: true });
      }
    } else {
      for (const [, script] of rest.matchAll(RUNNABLE)) facts.imports.push({ spec: script, names: ['runs'] });
    }
  }
}

const YAML_SCALARS = ['plain_scalar', 'single_quote_scalar', 'double_quote_scalar'];
const yamlText = node => (node.type === 'plain_scalar' ? node.text : node.text.slice(1, -1));
// the scalars inside a YAML value, without the keys of mappings inside it
const yamlValues = node => node.descendantsOfType(YAML_SCALARS)
  .filter(s => s.parent.parent?.childForFieldName('key')?.id !== s.parent.id).map(yamlText);

function readCompose(root, facts) {
  const push = (spec, label, folder) => {
    // Compose reads every path from the compose file's folder: here: true
    if (spec && !/^[a-z]+:\/\/|^git@|^\$|^\/|^~/i.test(spec)) facts.imports.push({ spec: spec.replace(/\\/g, '/'), names: [label], here: true, ...(folder && { folder }) });
  };
  for (const pair of root.descendantsOfType(['block_mapping_pair', 'flow_pair'])) {
    const key = pair.childForFieldName('key')?.text;
    const value = pair.childForFieldName('value');
    if (!value) continue;
    if (key === 'build') {
      // build: ./api   or   build: { context: ./web, dockerfile: ../docker/web.Dockerfile }
      const fields = Object.fromEntries(value.descendantsOfType(['block_mapping_pair', 'flow_pair'])
        .filter(p => p.childForFieldName('value')).map(p => [p.childForFieldName('key')?.text, yamlValues(p.childForFieldName('value'))[0]]));
      const context = value.descendantsOfType(['block_mapping_pair', 'flow_pair']).length ? fields.context ?? '.' : yamlValues(value)[0];
      // a git URL as context builds someone else's repository; dockerfile_inline has no file
      if (context != null && !/^[a-z]+:\/\/|^git@/i.test(context) && !('dockerfile_inline' in fields)) push(posix.join(context, fields.dockerfile ?? 'Dockerfile'), 'build');
    } else if (key === 'env_file' || key === 'include' || key === 'file') {
      for (const path of yamlValues(value)) push(path, key);
    } else if (key === 'volumes') {
      // ./data:/var/lib/data, or the long form's `source: ./conf`; named volumes are no files
      for (const entry of yamlValues(value)) if (/^\.\.?\//.test(entry)) push(entry.split(':')[0], 'volume', true);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Shared by Java, Kotlin and C#
// ---------------------------------------------------------------------------------------

// Annotations that make Spring (or Jakarta CDI / Micronaut) create the class and inject its constructor.
const MANAGED = ['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'ControllerAdvice', 'RestControllerAdvice', 'Named', 'Singleton', 'ApplicationScoped', 'RequestScoped'];
const INJECT = ['Autowired', 'Inject', 'Resource'];
const isSpringManaged = annotations => MANAGED.some(a => a in annotations);

const injection = (typeNode, annotations) => ({ types: typeNames(typeNode), qualifier: annotations.Qualifier || annotations.Named || '' });

// All capitalised type names in a type: `List<OrderHandler>` -> ['List', 'OrderHandler']
function typeNames(node) {
  if (!node) return [];
  const names = node.type === 'type_identifier' || node.type === 'identifier' ? [node] : node.descendantsOfType(['type_identifier', 'identifier']);
  return names.map(n => n.text).filter(isTypeName);
}

// The outer type of each entry in `extends A<B>, C`: ['A', 'C']
function outerTypes(node) {
  return node.descendantsOfType(['type_identifier', 'generic_type', 'scoped_type_identifier'])
    .filter(n => !n.parent || !['type_arguments', 'generic_type', 'scoped_type_identifier'].includes(n.parent.type))
    .map(n => (n.type === 'generic_type' ? n.namedChildren[0] : n).text.split('.').pop());
}

const isTypeName = name => /^[A-Z]/.test(name);

function collectUses(node, types, uses) {
  for (const n of node.descendantsOfType(types)) if (isTypeName(n.text)) uses.add(n.text);
}
