# pi-lsp

**Instant tree-sitter LSP emulation + compiler-backed type checking for [Pi](https://pi.dev) coding agent.**

- 🚀 **Sub-millisecond** — in-process WASM parser, zero daemon, zero child processes
- 🌐 **80+ languages** — TypeScript, Python, Rust, Go, C/C++, Java, Bash, CSS, JSON, YAML, and more
- 🔍 **Auto-checks after every edit** — re-parses changed files, injects diagnostics, updates symbol index
- 🧭 **LSP-style navigation** — go to definition, find references, hover, document symbols
- ✅ **Two-tier validation** — tree-sitter catches syntax instantly; real compiler catches types before done
- 📦 **Zero setup** — npm deps auto-installed, grammars bundled, no external binaries needed

## Install

```bash
pi install npm:pi-lsp
```

Or try without installing:

```bash
pi -e npm:pi-lsp
```

## What It Does

### Automatic (no action needed)

After every `edit`, `write`, or bash file redirect (`> file`), pi-lsp instantly re-parses the file. If syntax errors are found, they're injected into the agent context automatically — the LLM sees the errors and can fix them.

### Two-Tier Validation

**Tier 1 — Syntax (tree-sitter, instant, sub-ms)**
Catches missing brackets, unclosed blocks, invalid tokens across 80+ languages. Runs automatically after every edit.

**Tier 2 — Semantics (real compiler, before task complete)**
Runs the actual compiler/type checker (`tsc`, `cargo check`, `go build`, `mypy`, etc.) to catch type mismatches, missing imports, and logic errors that tree-sitter can't see. Auto-detects project type. Agent is instructed to run this before declaring work done.

### Tools (agent can call these)

| Tool | Description |
|------|-------------|
| `lsp_diagnostics` | Check a single file for syntax errors |
| `lsp_project_diagnostics` | Scan the entire project for syntax errors |
| `lsp_symbols` | List all symbols (functions, classes, variables) in a file |
| `lsp_definition` | Go to definition of a symbol at line/column |
| `lsp_references` | Find all references to a symbol in a file |
| `lsp_hover` | Get node type and info at a position |
| `run_type_check` | Run the project's compiler/type checker |

### Commands (you can type these)

| Command | Description |
|---------|-------------|
| `/lsp-check [path]` | Check a file or directory for syntax errors |
| `/lsp-project` | Scan the entire project for syntax errors |
| `/lsp-status` | Show parser status, loaded grammars, symbol index stats |
| `/symbols` | Show symbol index statistics |
| `/check` | Run the language type checker on the project |

## Supported Languages

TypeScript, TSX, JavaScript, JSX, Python, Rust, Go, C, C++, Java, C#, Swift, Kotlin, Scala, Ruby, Lua, Bash, Zsh, CSS, SCSS, HTML, JSON, YAML, TOML, Markdown, SQL, PHP, Elixir, Erlang, Haskell, OCaml, Nim, Zig, Dart, R, Julia, Perl, Vue, Svelte, Astro, GraphQL, Prisma, Dockerfile, CMake, Make, Nix, Fish, PowerShell, Protobuf, Terraform, HCL, Gleam, Solidity, Typst, LaTeX, and more — 80+ total.

## How It Works

**Syntax layer** uses [tree-sitter](https://tree-sitter.github.io/tree-sitter/) compiled to WebAssembly via [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web), with pre-built grammar WASMs from [tree-sitter-wasm](https://www.npmjs.com/package/tree-sitter-wasm). Everything runs in-process — no daemon, no child processes, no network calls.

**Symbol index** extracts definitions using generic tree-sitter heuristics: any node with a `name` field whose type matches a definition pattern (`*_definition`, `*_declaration`, function_, class_, etc.). Works for all 80+ languages without per-language query files. Parsed trees are cached and incrementally updated on every edit.

**Type check layer** auto-detects the project type from config files (`tsconfig.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, etc.) and runs the appropriate compiler/linter. Falls back through multiple commands if the primary tool isn't installed. Parses compiler output into structured diagnostics.

## Example Output

**Syntax diagnostics (instant):**
```
🔍 src/main.ts (typescript): 1 syntax error
  ❌ L17:18 — Missing `}` in statement_block
```

**Document symbols:**
```
📋 8 symbols in src/main.ts:

  **function** (1):
    L7:10 — `broken`
  **import** (3):
    L1:10 — `add`
    L1:15 — `greet`
    L1:22 — `Calculator`
  **variable** (4):
    L4:7 — `result`
    L8:9 — `msg` (in broken)
    L15:7 — `calc`
    L17:7 — `val`
```

**Go to definition:**
```
✅ `add` (import) → L1:10
```

**Find references:**
```
📌 2 reference(s) to `greet`:
     L1:15 — in import_specifier
     L8:15 — in call_expression
```

**Hover:**
```
**class**
\`\`\`
class
\`\`\`
```

**Type check (real compiler):**
```
🔍 1 issue(s) found by npx tsc --noEmit:
  ❌ L4:20 — Argument of type 'string' is not assignable to parameter of type 'number'.
```

**All clean:**
```
✅ Project clean — no syntax errors in 363/363 files
✅ Type check passed — detected typescript, npx tsc --noEmit
```

## Architecture

```
Agent edits file
    ↓
tree-sitter re-parses instantly (<1ms)
    ↓
Auto-updates symbol index (cached trees)
    ↓
Syntax errors? → injected into agent context
    ↓
Agent uses lsp_symbols / lsp_definition / lsp_references as needed
    ↓
Agent calls run_type_check before declaring done
    ↓
Real compiler catches type/semantic errors
    ↓
Agent fixes, re-runs check → clean ✅
```

### Symbol extraction

Generic heuristic walks any tree-sitter tree. Classifies nodes by type name pattern:

| Node type pattern | Kind | Languages |
|-------------------|------|-----------|
| `function_declaration`, `function_definition`, `function_item` | `function` | TS, Python, Rust, Go |
| `class_definition`, `class_declaration`, `struct_item` | `class` | TS, Python, Rust |
| `method_definition`, `method_declaration` | `method` | TS, Go |
| `variable_declarator`, `assignment`, `let_declaration` | `variable` | TS, Python, Rust |
| `interface_declaration`, `trait_item` | `interface` | TS, Rust |
| `enum_declaration`, `enum_item` | `enum` | TS, Rust |
| `import_specifier`, `use_declaration` | `import` | TS, Rust |

A node must also have a `name` field (via `childForFieldName("name")`) to be extracted. This filters out false positives like `return_statement` or `class_body` that match type patterns but aren't definitions.

### Type check commands

| Project type | Detected by | Command |
|-------------|-------------|---------|
| TypeScript | `tsconfig.json` | `npx tsc --noEmit` |
| JavaScript | `package.json` | `npx eslint . --format unix` |
| Rust | `Cargo.toml` | `cargo check --message-format short` |
| Go | `go.mod` | `go build ./...` |
| Python | `pyproject.toml`, `setup.py` | `ruff check`, `mypy .` |
| Java (Maven) | `pom.xml` | `mvn compile -q` |
| Java (Gradle) | `build.gradle` | `gradle compileJava -q` |
| C/C++ (CMake) | `CMakeLists.txt` | `cmake --build build` |
| C/C++ (Make) | `Makefile` | `make -k` |
| Ruby | `Gemfile` | `ruby -c` |
| PHP | `composer.json` | `php -l` |
| Elixir | `mix.exs` | `mix compile --no-deps-check` |
| Haskell | `stack.yaml`, `cabal.project` | `stack build`, `cabal build` |
| Scala | `build.sbt` | `sbt compile` |
| Swift | `Package.swift` | `swift build` |
| Zig | `build.zig` | `zig build` |
| Dart | `dub.json`, `dub.sdl` | `dart analyze` |

## License

MIT
