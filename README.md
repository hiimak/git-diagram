# git diagram

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

> The npm package is ready but not yet published. Until it is, install straight from GitHub (same result):
>
> ```bash
> npm install -g github:hiimak/git-diagram
> ```

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

> Tested: the npm install route on Windows. The Homebrew formula and the Linux/macOS commands are written but not yet run on those systems.

## Use

Run it inside any Git repository. A page opens in your default browser.

```bash
git diagram                  # everything not committed yet (staged, unstaged and new files)
git diagram --cached         # only what is staged
git diagram HEAD~3           # the last 3 commits plus what is uncommitted
git diagram main...HEAD      # everything on this branch since it left main
git diagram v1.2.0 v1.3.0    # between two tags
```

Anything you pass is handed to `git diff`, so any range that works there works here. Your index and files are never modified.

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
- **Files list** on the right: filter by name, jump to any file, step with ‹ ›. This is the quickest way in on a phone.
- **Show unchanged neighbours** adds the grey boxes. It starts off on big diffs (over 40 boxes) to keep the picture readable.
- **Light and dark** follow your system; the button in the header flips it.

![The same diagram in light mode, with unchanged connected files shown as dashed boxes](docs/light.png)

### Big diffs

Tested on a repository with about 100 changed files covering every kind of change (added, edited, deleted, renamed, renamed and edited, binary, empty, permission-only, untracked, file names with spaces and accents). It builds in under a second.

![A 100-file diff with a filtered file list and a renamed file selected](docs/big-diff.png)

## What it understands

It follows imports in **JavaScript and TypeScript** (`import`, `export … from`, `require`, dynamic `import()`, relative paths) and **Python** (`import x`, `from x import y`, relative imports). Other file types still appear as boxes with their diffs, just without arrows.

Known limits:

- Bare package imports and path aliases (for example `@/utils` from `tsconfig`) are not followed.
- Imports are read from your working tree, so for an old commit range the arrows show today's code.
- Connections are file to file, not function to function.
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
npm test
```

`git-diagram.mjs` holds all the logic (reading the diff, finding imports, building the graph). `page.html` is the page template. There are no dependencies.

## License

MIT
