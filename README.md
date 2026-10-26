# git diagram

[![npm](https://img.shields.io/npm/v/@hiimak/git-diagram)](https://www.npmjs.com/package/@hiimak/git-diagram)
[![tests](https://github.com/hiimak/git-diagram/actions/workflows/ci.yml/badge.svg)](https://github.com/hiimak/git-diagram/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@hiimak/git-diagram)](LICENSE)

**See a big diff as a picture before you read it line by line.**

`git diagram` turns your changes into an interactive diagram in the browser: one box per changed file, arrows showing which files feed data into which, and a click on any box shows that file's diff.

![git diagram in dark mode: boxes for each changed file, arrows between them, and the selected file's diff on the right](docs/dark.png)

## Why this exists

AI coding tools can change 40 files in one go. Reading that as a flat, alphabetical, line-by-line diff does not work: you can't see what the change *is*, only what it touches.

Reviewers need the shape of the change first:

- Which files are new, changed, deleted or renamed?
- How do they depend on each other? If `db.ts` changed, what else relies on it?
- Which functions and classes were touched?
- Where do I need to read closely, and what can I skim?

`git diagram` answers these in one glance and then lets you drill into any file. It looks a bit like a UML or BPMN diagram: folders are lanes, files are boxes, arrows are data flow.

## Install

You need [Node.js](https://nodejs.org) 20 or newer and Git. The command is `git-diagram`, which Git automatically exposes as `git diagram`.

### npm (Linux, macOS, Windows)

```bash
npm install -g @hiimak/git-diagram
```

pnpm, yarn and bun work too (`pnpm add -g @hiimak/git-diagram`, `bun add -g @hiimak/git-diagram`). To try it without installing:

```bash
npx @hiimak/git-diagram
```

### Homebrew (macOS, Linux)

```bash
brew tap hiimak/git-diagram https://github.com/hiimak/git-diagram
brew install --HEAD git-diagram
```

### Windows

Install Node once (`winget install OpenJS.NodeJS.LTS` or `scoop install nodejs-lts`), then use the npm command above.

### Linux

Install Node from your package manager (`sudo apt install nodejs npm`, `sudo dnf install nodejs`, `sudo pacman -S nodejs npm`) or from [nodejs.org](https://nodejs.org), then use the npm command above.

### From a clone

```bash
git clone https://github.com/hiimak/git-diagram.git
cd git-diagram
npm install -g .
```

> Tested: installing from npm on Windows. The Homebrew formula and the Linux/macOS commands are written but not yet run on those systems.

## Use

Run it inside any Git repository. A page opens in your default browser.

```bash
git diagram                  # everything not committed yet (staged, unstaged and new files)
git diagram --cached         # only what is staged
git diagram HEAD~3           # the last 3 commits plus what is uncommitted
git diagram main...HEAD      # everything on this branch since it left main
git diagram v1.2.0 v1.3.0    # between two tags
git diagram -i dist -i '*.lock'   # leave out the dist folder and all lock files
```

It prints where the page is, so you can open it yourself if no browser pops up (for example over SSH):

```text
git diagram: 4 changed files, 4 connections
Opening it in your browser. If nothing opens, follow this link:
  file:///home/you/project/.git/git-diagram.html
```

Anything you pass is handed to `git diff`, so any range that works there works here. Your index and files are never modified.

### Ignoring files

`-i <pattern>` (or `--ignore <pattern>`) leaves matching files out completely. Repeat it for more patterns. Patterns work like `.gitignore`:

| Pattern | Leaves out |
| --- | --- |
| `dist` | every file or folder named `dist`, at any depth, with everything inside it |
| `'*.lock'` | every `.lock` file, at any depth |
| `src/generated` | that one folder (a pattern with a `/` starts at the repository root) |
| `'src/**/*.gen.ts'` | `.gen.ts` files anywhere under `src` (`**` spans folders) |

Quote patterns with `*` so your shell does not expand them. Ignored files are never read, which also makes huge untracked folders fast to skip.

## Reading the diagram

| Colour | Meaning |
| --- | --- |
| Green | added |
| Amber | modified |
| Red | deleted |
| Blue | renamed (the detail panel shows the old name) |
| Grey, dashed | not changed, but connected to a changed file |

- **Arrows** point in the direction data flows: from the imported file to the file that uses it. The label shows what is imported.
- **Boxes** show the status, `+added −removed` lines, and the functions and classes the change touches.
- **Folders** are the grouped lanes.
- **Click a box** (or tap it, or press Enter on it) to see its diff with line numbers, what it gets data from, and what it feeds. The connected files stay bright and everything else dims.
- **Files list** on the right: jump to any file, step with ‹ ›. This is the quickest way in on a phone.
- **Filter box** above the list hides files in the list and the diagram. Type space-separated terms: plain text matches anywhere in the path, `*` and `**` work like in `-i`, and `!` in front hides matches. Example: `src !*.spec.ts !generated`.
- **Legend** items are filters: click added, modified, deleted, renamed or unchanged to hide or show that kind.
- **Zoom** with the buttons, a trackpad pinch, or Alt + mouse wheel over the diagram. **Drag the divider** between diagram and side panel to resize it (desktop).
- **Show unchanged neighbours** adds the grey boxes. It starts off on big diffs (over 40 boxes) to keep the picture readable.
- **Light and dark** follow your system; the button in the header flips it.

![The same diagram in light mode, with unchanged connected files shown as dashed boxes](docs/light.png)

### Big diffs

Tested on a repository with about 100 changed files covering every kind of change (added, edited, deleted, renamed, renamed and edited, binary, empty, permission-only, untracked, file names with spaces and accents). It builds in under a second.

![A 100-file diff with a filtered file list and a renamed file selected](docs/big-diff.png)

## What it understands

Every source file is read with a real parser ([tree-sitter](https://tree-sitter.github.io/)), so comments and strings never count as code. The parsers ship inside the package; there is nothing else to install.

| Language | Arrows come from |
| --- | --- |
| JavaScript, TypeScript (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`) | `import`, `export … from`, `require()`, `import()`; relative paths, `tsconfig.json` / `jsconfig.json` `paths` and `baseUrl` (nearest config, `extends` followed) |
| Python | `import x`, `from x import y`, relative imports |
| Java, Kotlin | imports (also static, wildcard and `as` aliases), classes of the same package used without an import, Java and Kotlin calling each other |
| Spring (Java, Kotlin) | dependency injection: an interface handed to a constructor, an `@Autowired`/`@Inject` field or a Lombok `@RequiredArgsConstructor` class also points at the implementation Spring injects (narrowed by `@Qualifier` and `@Primary`), and `@Bean` methods point at the classes that receive the bean |

More languages are coming: C#, Go, C, C++, PHP, Rust. Other files still appear as boxes with their diffs, just without arrows.

Known limits:

- Bare package imports (`react`, `java.util.List`) are not drawn: they are not files in your repository.
- Spring Data repositories, events, `Class.forName` and HTTP calls between services are not followed.
- The parser reads syntax, it does not compile: a type that is only inferred (`var x = factory.create()`) is not known.
- Imports are read from your working tree, so for an old commit range the arrows show today's code.
- Connections are file to file, not function to function.
- Every file of a language that appears in the diff is parsed: about 2 ms per file, so around 16 seconds for a 9,000-file Java repository.
- The page loads the diagram library (Mermaid) and fonts from a CDN. Offline you still get a file list with diffs, but no diagram.

## Privacy

Everything runs on your machine. The diff is written into one HTML file at `.git/git-diagram.html` and opened locally. Your code is never uploaded. The only network requests are for the diagram library and fonts.

## Look at it on your phone

The page is a single file. To see it on another device, serve it from your computer over a private network such as [Tailscale](https://tailscale.com):

```bash
cd .git
python3 -m http.server 8000 --bind <your-tailscale-ip>
```

Then open `http://<your-tailscale-ip>:8000/git-diagram.html` on the phone. Binding to the Tailscale address keeps it off your local network.

## Uninstall

```bash
npm uninstall -g @hiimak/git-diagram
```

## Develop

```bash
npm install
```

```bash
npm test
```

- `git-diagram.mjs`: the command (reading the diff, writing the page).
- `lib/parse.mjs`: reads one source file with tree-sitter and returns its imports, types and injections.
- `lib/graph.mjs`: turns those into arrows (import resolution, tsconfig aliases, the Java/Kotlin type index, Spring injection).
- `page.html`: the page template.
- `grammars/`: the bundled parsers. `npm run grammars` refreshes them from the official grammar packages (versions in `scripts/grammars.mjs`).

The only dependency is `web-tree-sitter`, the WebAssembly build of the parser, so nothing has to be compiled on install.

## License

MIT
