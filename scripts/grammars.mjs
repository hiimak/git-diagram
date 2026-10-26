// Refreshes grammars/*.wasm from the official tree-sitter grammar packages on npm.
// Run: node scripts/grammars.mjs   (needs npm and tar, both present on Windows 10+, macOS, Linux)
// To update a grammar, change its version here, run the script, run the tests, commit.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// package@version -> the .wasm files to take from it
const GRAMMARS = {
  'tree-sitter-javascript@0.25.0': ['tree-sitter-javascript.wasm'],
  'tree-sitter-typescript@0.23.2': ['tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm'],
  'tree-sitter-python@0.25.0': ['tree-sitter-python.wasm'],
  'tree-sitter-java@0.23.5': ['tree-sitter-java.wasm'],
  '@tree-sitter-grammars/tree-sitter-kotlin@1.1.0': ['tree-sitter-kotlin.wasm'],
  'tree-sitter-c-sharp@0.23.5': ['tree-sitter-c_sharp.wasm'],
  'tree-sitter-go@0.25.0': ['tree-sitter-go.wasm'],
};

const out = new URL('../grammars/', import.meta.url);
mkdirSync(out, { recursive: true });
const shell = process.platform === 'win32'; // npm is npm.cmd on Windows
for (const [pkg, wanted] of Object.entries(GRAMMARS)) {
  const dir = mkdtempSync(join(tmpdir(), 'grammar-'));
  try {
    const tgz = execFileSync('npm', ['pack', pkg, '--silent', '--pack-destination', dir], { encoding: 'utf8', shell }).trim().split('\n').pop();
    execFileSync('tar', ['-xzf', tgz], { cwd: dir });
    const found = readdirSync(join(dir, 'package'), { recursive: true }).map(String);
    for (const name of wanted) {
      const path = found.find(f => f.replace(/\\/g, '/').split('/').pop() === name);
      if (!path) throw new Error(`${name} not found in ${pkg}`);
      copyFileSync(join(dir, 'package', path), new URL(name, out));
      console.log(`${pkg} -> grammars/${name}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
