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

import { readFileSync } from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';

// file extension -> grammar (grammars/tree-sitter-<name>.wasm)
const GRAMMAR = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  cs: 'c_sharp', go: 'go',
};

// Languages that resolve imports the same way and can see each other's files.
const FAMILY = { javascript: 'js', typescript: 'js', tsx: 'js', python: 'python', java: 'jvm', kotlin: 'jvm', c_sharp: 'dotnet', go: 'go' };

export const grammarOf = path => GRAMMAR[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
export const familyOf = path => FAMILY[grammarOf(path)];

const parsers = new Map(); // grammar -> Parser, filled by loadGrammars

// Loads the grammars for the given families. A grammar that fails to load is reported once
// and its files simply get no arrows.
export async function loadGrammars(families) {
  await Parser.init();
  for (const [grammar, family] of Object.entries(FAMILY)) {
    if (!families.has(family) || parsers.has(grammar)) continue;
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
  const grammar = grammarOf(path);
  const parser = parsers.get(grammar);
  if (!parser) return null;
  const tree = parser.parse(source);
  try {
    const facts = { lang: FAMILY[grammar], package: '', imports: [], types: [], uses: new Set() };
    READERS[FAMILY[grammar]](tree.rootNode, facts);
    return facts;
  } finally {
    tree.delete(); // trees live in WebAssembly memory, not freed by the garbage collector
  }
}

const READERS = {
  js: readJs, python: readPython, dotnet: readCsharp, go: readGo,
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
