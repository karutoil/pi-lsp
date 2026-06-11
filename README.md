# pi-lsp

**Instant tree-sitter syntax diagnostics for [Pi](https://pi.dev) coding agent.**

- 🚀 **Sub-millisecond** — in-process WASM parser, zero daemon, zero child processes
- 🌐 **80+ languages** — TypeScript, Python, Rust, Go, C/C++, Java, Bash, CSS, JSON, YAML, and more
- 🔍 **Auto-checks after every edit** — re-parses changed files and injects diagnostics into agent context
- 📦 **Zero setup** — npm deps auto-installed, grammars bundled, no external binaries needed
- 🎯 **Syntax errors only** — catches missing brackets, invalid tokens, unclosed blocks (not type errors)

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

### Tools (agent can call these)

| Tool | Description |
|------|-------------|
| `lsp_diagnostics` | Check a single file for syntax errors |
| `lsp_project_diagnostics` | Scan the entire project for syntax errors |

### Commands (you can type these)

| Command | Description |
|---------|-------------|
| `/lsp-check [path]` | Check a file or directory (default: whole project) |
| `/lsp-project` | Scan the entire project for syntax errors |
| `/lsp-status` | Show parser status, loaded grammars, supported languages |

## Supported Languages

TypeScript, TSX, JavaScript, JSX, Python, Rust, Go, C, C++, Java, C#, Swift, Kotlin, Scala, Ruby, Lua, Bash, Zsh, CSS, SCSS, HTML, JSON, YAML, TOML, Markdown, SQL, PHP, Elixir, Erlang, Haskell, OCaml, Nim, Zig, Dart, R, Julia, Perl, Vue, Svelte, Astro, GraphQL, Prisma, Dockerfile, CMake, Make, Nix, Fish, PowerShell, Protobuf, Terraform, HCL, Gleam, Solidity, Typst, LaTeX, and more — 80+ total.

## How It Works

Uses [tree-sitter](https://tree-sitter.github.io/tree-sitter/) compiled to WebAssembly via [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web), with pre-built grammar WASMs from [tree-sitter-wasm](https://www.npmjs.com/package/tree-sitter-wasm). Everything runs in-process — no daemon, no child processes, no network calls.

## Example Output

```
🔍 src/auth.ts (typescript): 2 syntax errors
  ❌ L15:8 — Missing `)` in parameter_list
  ❌ L23:1 — Syntax error: unexpected `}`
```

```
✅ Project clean — no syntax errors in 363/363 files
```

## License

MIT
