# Changelog

All notable changes to `git diagram`. Versions follow [semantic versioning](https://semver.org/).

## 0.3.2 — 2026-10-28

- Click and hold to drag the diagram around with the mouse.
- Zoom with Ctrl + mouse wheel instead of Alt + mouse wheel. One wheel notch now zooms as much as one press of the + button.
- README: new "Controls" section covering navigation, zoom, the legend, the neighbours toggle and the filter box syntax.

## 0.3.1 — 2026-10-27

- Boxes and the side panel show what kind each touched symbol is (`class`, `interface`, `function`, `method`, `constructor`, `variable` and so on) instead of a generic `ƒ` prefix.
- Methods and constructors without a keyword are detected in Java, C# and TypeScript classes and interfaces.

## 0.3.0 — 2026-10-26

- C# support: `using` directives (including aliases, `static` and `global`), file-scoped and block namespaces, and ASP.NET Core injection (constructor and primary-constructor parameters, `[Inject]` properties, `AddScoped` / `AddTransient` / `AddSingleton` registrations).
- Go support: packages and modules from `go.mod`, arrows between files of the same package, and imports narrowed to the files that declare the names used.

## 0.2.0 — 2026-10-26

- Parsing moved from regular expressions to tree-sitter.
- Java and Kotlin support, including Spring dependency injection (constructor, field and `@Bean` providers, interface implementations, qualifiers).
- TypeScript path aliases from `tsconfig.json`.

## 0.1.3 — 2026-10-26

- `-i <pattern>` / `--ignore <pattern>` leaves files out, with `.gitignore`-style patterns.
- The page's filter box accepts `*` and `**` wildcards and `!term` to hide matches.
- Diffs bigger than the maximum string length no longer crash. Very long per-file diffs are capped in the page.

## 0.1.2 — 2026-10-26

- Fix: runs when installed as a symlink, as npm does on Linux and macOS.

## 0.1.1 — 2026-10-26

- Prints a clickable link to the page, for when no browser opens (for example over SSH).

## 0.1.0 — 2026-10-24

First release.

- `git diagram [git diff args]` opens an interactive diagram in the browser: one box per changed file, arrows for data flow between them, and a click on a box shows its diff.
- Reads JavaScript, TypeScript and Python imports.
- Resizable side panel, legend that doubles as a status filter, zoom with trackpad pinch or Alt + mouse wheel, light and dark theme.
- Published on npm as `@hiimak/git-diagram`, with a Homebrew formula.
