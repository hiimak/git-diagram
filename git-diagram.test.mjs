import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, toMermaid, parseArgs, excludePathspecs } from './git-diagram.mjs';
import { buildGraph, resolve, parseJsonc } from './lib/graph.mjs';
import { loadGrammars, parseFile } from './lib/parse.mjs';

await loadGrammars(new Set(['js', 'python', 'jvm', 'dotnet', 'go']));
const importsOf = (path, source) => parseFile(path, source).imports.map(({ spec, names }) => ({ spec, names }));
const ctxFor = (files, sources = {}) => ({ repoFiles: new Set(files), readFile: p => sources[p] ?? null, tsconfigs: new Map() });

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
  assert.deepEqual(api.symbols, [{ name: 'load', kind: 'function' }, { name: 'fetchUser', kind: 'variable' }]);
  assert.deepEqual([py.status, py.add, py.symbols], ['added', 2, [{ name: 'handler', kind: 'function' }]]);
  const [kinds] = parseDiff('diff --git a/x b/x\n@@ -1 +1 @@\n+public sealed class Order {\n+func (s *Store) Save() {\n+interface Repo {\n+data class Item(val id: Int)\n');
  assert.deepEqual(kinds.symbols.map(s => `${s.kind} ${s.name}`), ['class Order', 'function Save', 'interface Repo', 'class Item']);
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

test('imports are read for JS/TS and Python', () => {
  assert.deepEqual(importsOf('a.ts', `import React, { useState as s } from 'react';
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
  assert.deepEqual(importsOf('p/m.py', 'import os, pkg.util as u\nfrom . import helpers\nfrom ..core.models import (User, Order)\n'), [
    { spec: 'os', names: [] },
    { spec: 'pkg.util', names: [] },
    { spec: '.', names: ['helpers'] },
    { spec: '..core.models', names: ['User', 'Order'] },
  ]);
});

test('resolve maps imports to repo files', () => {
  const files = ctxFor(['src/db.ts', 'src/lib/index.tsx', 'src/esm.ts', 'app/core/models.py', 'app/web/helpers.py', 'app/web/__init__.py']);
  assert.deepEqual(resolve('src/api.ts', { spec: './db', names: [] }, files), ['src/db.ts']);
  assert.deepEqual(resolve('src/api.ts', { spec: './lib', names: [] }, files), ['src/lib/index.tsx']);
  assert.deepEqual(resolve('src/api.ts', { spec: './esm.js', names: [] }, files), ['src/esm.ts']);
  assert.deepEqual(resolve('src/api.ts', { spec: 'react', names: [] }, files), []);
  assert.deepEqual(resolve('app/web/view.py', { spec: '..core.models', names: ['User'] }, files), ['app/core/models.py']);
  assert.deepEqual(resolve('app/web/view.py', { spec: '.', names: ['helpers'] }, files), ['app/web/__init__.py', 'app/web/helpers.py']);
  assert.deepEqual(resolve('main.py', { spec: 'app.core.models', names: [] }, files), ['app/core/models.py']);
});

test('buildGraph keeps only edges touching changed files, as data flow', async () => {
  const src = { 'a.ts': "import { b } from './b'", 'b.ts': "import { c } from './c'", 'c.ts': '', 'z.ts': "import './c'" };
  const edges = await buildGraph([{ path: 'b.ts' }], new Set(Object.keys(src)), p => src[p]);
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

test('tsconfig paths and baseUrl resolve, with comments and extends', () => {
  const sources = {
    'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", /* shared */ "paths": { "@/*": ["src/*"], "@lib": ["libs/lib/index.ts"], } } }',
    'tsconfig.json': '// root config\n{ "extends": "./tsconfig.base.json" }',
    'apps/web/tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
  };
  const ctx = ctxFor(['src/core/api.ts', 'libs/lib/index.ts', 'shared/util.ts', 'apps/web/src/page.tsx', ...Object.keys(sources)], sources);
  assert.deepEqual(resolve('src/app/x.ts', { spec: '@/core/api', names: [] }, ctx), ['src/core/api.ts']);
  assert.deepEqual(resolve('src/app/x.ts', { spec: '@lib', names: [] }, ctx), ['libs/lib/index.ts']);
  assert.deepEqual(resolve('src/app/x.ts', { spec: 'shared/util', names: [] }, ctx), ['shared/util.ts']);
  assert.deepEqual(resolve('src/app/x.ts', { spec: 'react', names: [] }, ctx), []);
  assert.deepEqual(resolve('apps/web/src/a/b.ts', { spec: '~/page', names: [] }, ctx), ['apps/web/src/page.tsx']);
  assert.deepEqual(parseJsonc('{ "a": "http://x/*y*/", // c\n "b": [1,], }'), { a: 'http://x/*y*/', b: [1] });
});

// A small Spring shop: interfaces with one and with two implementations, @Primary, @Qualifier,
// Lombok constructor injection, same-package use without import, @Bean, and Kotlin calling Java.
const SHOP = {
  'src/main/java/com/shop/service/OrderService.java': 'package com.shop.service;\npublic interface OrderService { void place(); }',
  'src/main/java/com/shop/service/OrderServiceImpl.java': 'package com.shop.service;\n@Service\npublic class OrderServiceImpl implements OrderService { public void place() {} }',
  'src/main/java/com/shop/pay/PaymentGateway.java': 'package com.shop.pay;\npublic interface PaymentGateway {}',
  'src/main/java/com/shop/pay/FastPay.java': 'package com.shop.pay;\n@Service("fast")\nclass FastPay implements PaymentGateway {}',
  'src/main/java/com/shop/pay/SlowPay.java': 'package com.shop.pay;\n@Primary @Service\nclass SlowPay implements PaymentGateway {}',
  'src/main/java/com/shop/web/OrderController.java': `package com.shop.web;
import com.shop.service.*;
import com.shop.pay.PaymentGateway;
// a comment naming Unused must not count
@RestController @RequiredArgsConstructor
public class OrderController {
  private final OrderService orders;
  private final PaymentGateway defaultGateway;
  @Autowired @Qualifier("fast") private PaymentGateway fast;
  OrderDto get() { String s = "Unused"; return new OrderDto(); }
}`,
  'src/main/java/com/shop/web/OrderDto.java': 'package com.shop.web;\npublic record OrderDto() {}',
  'src/main/java/com/shop/web/Unused.java': 'package com.shop.web;\nclass Unused {}',
  'src/main/java/com/shop/time/Clock.java': 'package com.shop.time;\npublic interface Clock {}',
  'src/main/java/com/shop/config/AppConfig.java': 'package com.shop.config;\nimport com.shop.time.Clock;\n@Configuration\npublic class AppConfig { @Bean Clock clock() { return null; } @Bean RestTemplate rest() { return null; } }',
  'src/main/kotlin/com/shop/notify/Notifier.kt': 'package com.shop.notify\nimport com.shop.service.OrderService\nimport com.shop.time.Clock as Time\n@Service\nclass Notifier(private val orders: OrderService, private val time: Time, private val rest: RestTemplate)',
};

test('Java and Kotlin: imports, same package, and Spring injection', async () => {
  const edges = await buildGraph(Object.keys(SHOP).map(path => ({ path })), new Set(Object.keys(SHOP)), p => SHOP[p]);
  const short = p => p.split('/').pop().replace(/\.\w+$/, '');
  const got = edges.map(e => `${short(e.from)} -> ${short(e.to)}: ${e.names.sort().join(', ')}`).sort();
  assert.deepEqual(got, [
    'AppConfig -> Notifier: AppConfig.clock() (@Bean), AppConfig.rest() (@Bean)',
    'Clock -> AppConfig: Clock',
    'Clock -> Notifier: Time',
    'FastPay -> OrderController: FastPay (injected)',
    'OrderDto -> OrderController: OrderDto',
    'OrderService -> Notifier: OrderService',
    'OrderService -> OrderController: OrderService',
    'OrderService -> OrderServiceImpl: OrderService',
    'OrderServiceImpl -> Notifier: OrderServiceImpl (injected)',
    'OrderServiceImpl -> OrderController: OrderServiceImpl (injected)',
    'PaymentGateway -> FastPay: PaymentGateway',
    'PaymentGateway -> OrderController: PaymentGateway',
    'PaymentGateway -> SlowPay: PaymentGateway',
    'SlowPay -> OrderController: SlowPay (injected)',
  ]);
});

const edgeList = async files => {
  const edges = await buildGraph(Object.keys(files).map(path => ({ path })), new Set(Object.keys(files)), p => files[p]);
  const short = p => p.split('/').pop().replace(/\.\w+$/, '');
  return edges.map(e => `${short(e.from)} -> ${short(e.to)}: ${e.names.sort().join(', ')}`).sort();
};

test('C#: usings, global usings, enclosing namespaces, aliases and registered injection', async () => {
  assert.deepEqual(await edgeList({
    'Core/Order.cs': 'namespace Shop.Core;\npublic record Order(int Id);',
    'Core/IPayment.cs': 'namespace Shop.Core { public interface IPayment {} }',
    'Payments/CardPayment.cs': 'using Shop.Core;\nnamespace Shop.Payments;\npublic class CardPayment : IPayment {}',
    'Payments/CashPayment.cs': 'using Shop.Core;\nnamespace Shop.Payments;\nclass CashPayment : IPayment {}',
    'Data/OrderRepository.cs': 'namespace Shop.Data { public static class OrderRepository { public static Order Find(int id) => null; } }',
    'Web/GlobalUsings.cs': 'global using Shop.Core;',
    'Web/Helpers.cs': 'namespace Shop { static class Helpers { public static void Log() {} } }',
    'Web/Program.cs': 'using Shop.Payments;\nvar builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddScoped<IPayment, CardPayment>();',
    'Web/OrdersController.cs': `using Repo = Shop.Data.OrderRepository;
namespace Shop.Web.Controllers;
// Unused in a comment does not count
[ApiController]
public class OrdersController(IPayment pay) : ControllerBase {
  public Order Get(int id) { Helpers.Log(); return Repo.Find(id); }
}`,
  }), [
    'CardPayment -> OrdersController: CardPayment (injected)',
    'CardPayment -> Program: CardPayment',
    'Helpers -> OrdersController: Helpers',
    'IPayment -> CardPayment: IPayment',
    'IPayment -> CashPayment: IPayment',
    'IPayment -> OrdersController: IPayment',
    'IPayment -> Program: IPayment',
    'Order -> OrderRepository: Order',
    'Order -> OrdersController: Order',
    'OrderRepository -> OrdersController: Repo',
  ]);
});

test('Go: packages by folder via go.mod, only the files that declare what is used', async () => {
  assert.deepEqual(await edgeList({
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'store/store.go': 'package store\n\ntype Store struct{}\n\nfunc New() *Store { return &Store{} }\n',
    'store/cache.go': 'package store\n\nvar Cache = map[string]int{}\n\nfunc init() {}\n',
    'store/db.go': 'package store\n\nfunc init() { Cache["a"] = 1 }\n',
    'store/store_test.go': 'package store\n\nimport "testing"\n\nfunc TestNew(t *testing.T) { New() }\n',
    'model/order.go': 'package model\n\ntype Order struct{ ID int }\n',
    'web/handler.go': 'package web\n\nimport (\n\t"fmt"\n\tdb "example.com/shop/store"\n\t"example.com/shop/model"\n)\n\ntype Handler struct{ s *db.Store }\n\nfunc (h *Handler) Get() model.Order { fmt.Println(); return model.Order{} }\n',
    'web/routes.go': 'package web\n\nfunc Routes() *Handler { return &Handler{} }\n',
    'cmd/main.go': 'package main\n\nimport (\n\t_ "example.com/shop/model"\n\t"example.com/shop/web"\n)\n\nfunc main() { web.Routes() }\n',
  }), [
    'cache -> db: Cache',
    'handler -> routes: Handler',
    'order -> handler: model.Order',
    'order -> main: ',
    'routes -> main: web.Routes',
    'store -> handler: db.Store',
    'store -> store_test: New',
  ]);
});
