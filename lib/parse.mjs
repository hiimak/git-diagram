// Reads one source file with tree-sitter and returns the facts the graph needs, the same shape
// for every language:
//   { lang, package, imports, types, uses }
//   package: 'com.shop.web' (Java/Kotlin), '' otherwise
//   imports: [{ spec, names, wildcard, alias }]   spec is what the file wrote: './db', '.models', 'com.shop.Order'
//   types:   classes / interfaces declared in the file (Java/Kotlin), each
//            { name, kind, supers, annotations, injects, beans }
//              kind:        'class' | 'interface' | 'abstract'
//              supers:      names it extends / implements
//              annotations: { Service: '', Qualifier: 'fast' }  (annotation name -> first string argument)
//              injects:     [{ types, qualifier }]  what Spring hands it (constructor, @Autowired, @Bean params)
//              beans:       [{ types, name, primary }]  what its @Bean methods return
//   uses:    capitalised names used in the code (Java/Kotlin), for classes that need no import

import { readFileSync } from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';

// file extension -> grammar (grammars/tree-sitter-<name>.wasm)
const GRAMMAR = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
};

// Languages that resolve imports the same way and can see each other's files.
const FAMILY = { javascript: 'js', typescript: 'js', tsx: 'js', python: 'python', java: 'jvm', kotlin: 'jvm' };

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

const READERS = { js: readJs, python: readPython, jvm: (root, facts) => (root.type === 'program' ? readJava : readKotlin)(root, facts) };

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
// Shared by Java and Kotlin
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
