import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, toMermaid, parseArgs, excludePathspecs } from './git-diagram.mjs';
import { buildGraph, resolve, parseJsonc } from './lib/graph.mjs';
import { loadGrammars, parseFile } from './lib/parse.mjs';

await loadGrammars(new Set(['js', 'python', 'jvm', 'dotnet', 'go', 'c', 'script']));
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
  // methods have no keyword: found by shape, while calls are not
  const lines = {
    'A.java': ['@Override public List<Owner> findAll(int page) {', 'public <T> T get(Class<T> type) {', 'public OwnerController(OwnerRepository owners) {', 'return owners.findAll(page);', 'throw new IllegalStateException("x");', 'else save(owner);'],
    'B.cs': ['[HttpGet("{id}")] public async Task<IActionResult> Get(int id)', 'public BasketService(IRepository<Basket> repo,', 'return await _repo.ListAsync(spec);', 'Guard.Against.Null(basket, nameof(basket));', 'basket = new Basket(id);'],
    'C.ts': ['async load(@Param() id: string): Promise<User> {', 'constructor(private readonly db: Db) {}', 'private save(', 'register?(options: any): Module;', "describe('x', () => {", "it('y', async function () {", 'if (ready) {', 'expect(', 'foo(x);'],
    'D.c': ['static const char *name(int x) {', 'struct node {', 'struct node *next(struct node *n)', 'void free(void *);', 'const char *msg = "x";', 'return foo(x);', 'default: panic("x");', ' * see listNext() for details'],
    'E.cpp': ['std::vector<int> Store::load(const Key& k) const', 'Store::~Store() {', 'explicit Cache(const Options& o) : o_(o) {}', 'enum class Color {', 'Random rnd(301);', 'MutexLock l(&mu);', 'Start();', 'TEST_F(DBTest, Empty) {'],
    'F.sh': ['deploy() {', 'function build_all {', 'source lib.sh', 'echo "function x"'],
    'G.ps1': ['function Get-Thing {', 'class Store {', 'enum Color { Red }', 'Get-Thing -Name x'],
    'api/Dockerfile': ['FROM node:20 AS build', 'FROM --platform=linux/amd64 nginx AS web', 'FROM alpine', 'RUN make'],
  };
  const found = Object.entries(lines).map(([path, ls]) => parseDiff(`diff --git a/${path} b/${path}\n@@ -1 +1 @@\n${ls.map(l => '+' + l).join('\n')}\n`)[0].symbols.map(s => `${s.kind} ${s.name}`));
  assert.deepEqual(found, [
    ['method findAll', 'method get', 'constructor OwnerController'],
    ['method Get', 'constructor BasketService'],
    ['method load', 'constructor constructor', 'method save', 'method register'],
    ['function name', 'struct node', 'function next', 'function free'],
    ['method Store::load', 'destructor Store::~Store', 'constructor Cache', 'enum class Color'],
    ['function deploy', 'function build_all'],
    ['function Get-Thing', 'class Store', 'enum Color'],
    ['stage build', 'stage web'],
  ]);
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

const edgeList = async (files, keepExtension) => {
  const edges = await buildGraph(Object.keys(files).map(path => ({ path })), new Set(Object.keys(files)), p => files[p]);
  const short = p => p.split('/').pop().replace(keepExtension ? /$/ : /\.\w+$/, '');
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

test('C / C++: #include next to the file or under any include folder, and implements', async () => {
  assert.deepEqual(await edgeList({
    'include/net/socket.h': '#pragma once\nint sock_open(void);\n',
    'src/net/socket.c': '#include "net/socket.h"\n#include <stdio.h>\nint sock_open(void) { return 0; }\n',
    'src/util.h': 'int util(void);\n',
    'src/util.c': '#include "util.h"\n',
    'src/main.c': '#include "util.h"\n#ifdef NET\n#include <net/socket.h>\n#endif\nint main() {}\n',
    'lib/store.hpp': '#pragma once\nclass Store {};\n',
    'lib/store.cpp': '#include "store.hpp"\n#include <vector>\n',
    'app/app.cc': '#include "../lib/store.hpp"\n',
    'other/util.h': 'int other(void);\n',
  }, true), [
    'socket.h -> main.c: ',
    'socket.h -> socket.c: implements',
    'store.hpp -> app.cc: ',
    'store.hpp -> store.cpp: implements',
    'util.h -> main.c: ',
    'util.h -> util.c: implements',
  ]);
});

test('Bash, PowerShell, Dockerfile and docker-compose: edge cases of reading paths', () => {
  const read = (path, source) => parseFile(path, source)?.imports.map(i => `${i.names[0]} ${i.spec}${i.folder ? ' (folder)' : ''}`);
  const cases = [
    // Bash: comments, strings and here-docs are no commands
    ['a.sh', '# source x.sh\necho "source y.sh"\ncat <<EOF\nsource z.sh\nEOF\n', []],
    ['a.sh', 'if [ -f lib.sh ]; then . lib.sh; fi\nx=$(source sub.sh)\n', ['source lib.sh', 'source sub.sh']],
    // the script's folder, its parent, the repository root, and plain variables
    ['a.sh', 'HERE="$(cd "$(dirname "$0")" && pwd)"\nsource "$HERE/a.sh"\n', ['source a.sh']],
    ['a.sh', 'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n. "$ROOT/lib/x.sh"\n', ['source ../lib/x.sh']],
    ['a.sh', 'TOP=$(git rev-parse --show-toplevel)\nsource "$TOP/ci/env.sh"\n', ['source /ci/env.sh']],
    ['bin/a', '#!/bin/bash\n. "$(dirname "$(dirname "$0")")/lib/f.bash"\nsource "`dirname $0`/g.sh"\n', ['source ../lib/f.bash', 'source g.sh']],
    ['a.sh', 'LIB=lib\nsource "${LIB}/x.sh"\nsource "$(realpath "$(dirname "$0")")/y.sh"\n', ['source lib/x.sh', 'source y.sh']],
    // what cannot be followed
    ['a.sh', 'source "$1"\nsource ~/.bashrc\nsource /etc/profile\n. "$HOME/x.sh"\nsource lib/*.sh\nsource ${X:-a.sh}\n', []],
    // runners and wrappers; options are skipped
    ['a.sh', 'bash -x ./run.sh\nexec ./serve.sh "$@"\nsudo -E ./install.sh\nnohup ./bg.sh &\n/usr/bin/env\nsh -c "echo"\n', ['runs run.sh', 'runs serve.sh', 'runs install.sh', 'runs bg.sh']],
    // PowerShell
    ['a.ps1', '# . .\\x.ps1\n<# . .\\y.ps1 #>\n"& .\\z.ps1"\n', []],
    ['a.ps1', String.raw`$root = Split-Path -Parent $PSScriptRoot
. "$root\lib\x.ps1"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $here 'tools\b.ps1')
Import-Module -Name "$PSScriptRoot\Mods\Store.psm1" -Force
Import-Module $env:MODULE
. $PSCommandPath
& $exe`, ['dot-source ../lib/x.ps1', 'runs tools/b.ps1', 'Import-Module Mods/Store.psm1']],
    ['a.ps1', '$ROOT = $PSScriptRoot\n. $root\\x.ps1\n. ${Root}/y.ps1\n', ['dot-source x.ps1', 'dot-source y.ps1']],
    // Dockerfile
    ['Dockerfile', 'copy a.txt b.txt /app/\nCOPY --link --chown=1000:1000 ["c d.txt", "./"]\nADD https://x.io/a.tgz /\nCOPY --from=build /out /out\nCOPY <<EOF /x\nhi\nEOF\nCOPY $SRC /src\nCOPY ./ ./\n# COPY gone.txt /\n', ['COPY a.txt (folder)', 'COPY b.txt (folder)', 'COPY c d.txt (folder)']],
    ['app.Dockerfile', 'COPY .\\win\\app C:\\app\nRUN pip install -r requirements.txt && python manage.py migrate\nCMD ["/entry.sh"]\nENTRYPOINT ["sh", "./docker/entry.sh"]\n', ['COPY win/app (folder)', 'runs manage.py', 'runs ./docker/entry.sh']],
    ['Dockerfile.md', 'COPY a /a\n', undefined],
    // docker-compose
    ['compose.yaml', 'services:\n  a:\n    build: { context: ., dockerfile: Dockerfile.dev }\n    env_file:\n      - path: ./a.env\n        required: false\n    volumes: [".:/app", "../shared:/s:ro", "cache:/c", "/abs:/x"]\n    dockerfile_inline: x\n  b:\n    build:\n      context: https://github.com/x/y.git\n      dockerfile_inline: |\n        FROM alpine\nsecrets:\n  db:\n    file: ./db.txt\n',
      ['build Dockerfile.dev', 'env_file ./a.env', 'env_file false', 'volume ../shared (folder)', 'file ./db.txt']],
  ];
  for (const [path, source, expected] of cases) assert.deepEqual(read(path, source), expected, `${path}: ${source}`);
});

test('Bash, PowerShell, Dockerfile and docker-compose: the files they name', async () => {
  const files = {
    'scripts/deploy.sh': 'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nsource "$DIR/lib/common.sh"\n./scripts/build.sh --fast\nsource "$HOME/.profile"\n# source scripts/old.sh\n',
    'scripts/lib/common.sh': 'log() { echo "$@"; }\n',
    'scripts/build.sh': 'bash ./lib/common.sh\n',
    'scripts/old.sh': '',
    'bin/run': '#!/usr/bin/env bash\n. "${BASH_SOURCE%/*}/../scripts/deploy.sh"\n: lib\n\\. ../scripts/old.sh\n',
    'bin/notes': 'source scripts/old.sh\n',
    // sourced by bin/run, so its $0 is bin/run: found by the end of the path
    'scripts/lib/cmd.bash': '. "$(dirname "$(dirname "$0")")/scripts/lib/common.sh"\n',
    'ps/Setup.ps1': String.raw`. "$PSScriptRoot\lib\Util.ps1"` + '\nImport-Module (Join-Path $PSScriptRoot "Store")\nImport-Module Az\n',
    'ps/lib/Util.ps1': 'function Get-Thing {}\n',
    'ps/Store/Store.psd1': "@{ RootModule = 'Store.psm1' }\n",
    'ps/Store/Store.psm1': '',
    'api/Dockerfile': 'FROM node:20 AS build\nCOPY package*.json ./\nCOPY src/ \\\n  ./src\nCOPY --from=build /app /app\nCOPY . .\nRUN ./docker/entrypoint.sh\n',
    'api/package.json': '{}',
    'api/package-lock.json': '{}',
    'api/src/server.js': '',
    'api/src/unchanged.js': '',
    'api/docker/entrypoint.sh': '',
    'docker-compose.yml': 'services:\n  api:\n    build: ./api\n    env_file: [.env]\n    volumes:\n      - ./conf:/etc/app\n      - data:/var/lib\n',
    '.env': '',
    'conf/app.ini': '',
    // ./web is svc/web, whose files did not change; the changed web/ at the root is another folder
    'svc/compose.yaml': 'services:\n  web:\n    volumes: ["./web:/srv"]\n',
    'svc/web/keep.txt': '',
    'web/app.js': '',
  };
  const changed = Object.keys(files).filter(p => p !== 'api/src/unchanged.js' && p !== 'svc/web/keep.txt');
  const edges = await buildGraph(changed.map(path => ({ path })), new Set(Object.keys(files)), p => files[p]);
  assert.deepEqual(edges.map(e => `${e.from} -> ${e.to}: ${e.names.join(', ')}`).sort(), [
    '.env -> docker-compose.yml: env_file',
    'api/Dockerfile -> docker-compose.yml: build',
    'api/docker/entrypoint.sh -> api/Dockerfile: runs',
    'api/package-lock.json -> api/Dockerfile: COPY',
    'api/package.json -> api/Dockerfile: COPY',
    'api/src/server.js -> api/Dockerfile: COPY',
    'conf/app.ini -> docker-compose.yml: volume',
    'ps/Store/Store.psd1 -> ps/Setup.ps1: Import-Module',
    'ps/Store/Store.psm1 -> ps/Setup.ps1: Import-Module',
    'ps/Store/Store.psm1 -> ps/Store/Store.psd1: module',
    'ps/lib/Util.ps1 -> ps/Setup.ps1: dot-source',
    'scripts/build.sh -> scripts/deploy.sh: runs',
    'scripts/deploy.sh -> bin/run: source',
    'scripts/lib/common.sh -> scripts/build.sh: runs',
    'scripts/lib/common.sh -> scripts/deploy.sh: source',
    'scripts/lib/common.sh -> scripts/lib/cmd.bash: source',
    'scripts/old.sh -> bin/run: source',
  ]);
});
