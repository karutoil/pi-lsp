/**
 * pi-lsp v2 — Instant tree-sitter diagnostics for Pi
 *
 * In-process WASM parser, sub-ms per file, 80+ languages.
 * After every edit/write/bash that mutates files, re-parses
 * the changed file and injects syntax diagnostics into the agent context.
 *
 * Zero setup: npm dependencies auto-installed by Pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join, extname, resolve, dirname } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────────────

interface Diagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: "error" | "warning";
  context: string; // the error node text, truncated
}

// ── Constants ────────────────────────────────────────────────────────────────

// Resolve grammar dir — try multiple locations to work across install methods:
// 1. npm package: node_modules is sibling to extensions/ dir
// 2. Local dir: node_modules is in the extension root dir
// 3. Fallback: search parent directories
function findGrammarDir(): string {
  const candidates = [
    // npm package layout: extensions/../node_modules/
    join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "tree-sitter-wasm", "out"),
    // Local extension dir: ./node_modules/ (same dir as index.ts)
    join(dirname(fileURLToPath(import.meta.url)), "node_modules", "tree-sitter-wasm", "out"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "typescript", "tree-sitter-typescript.wasm"))) return dir;
  }
  // Fallback: walk up looking for node_modules/tree-sitter-wasm
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "node_modules", "tree-sitter-wasm", "out");
    if (existsSync(join(candidate, "typescript", "tree-sitter-typescript.wasm"))) return candidate;
    dir = join(dir, "..");
  }
  return candidates[0]; // Return first candidate even if missing (will error later with clear message)
}

const GRAMMAR_DIR = findGrammarDir();

// File extension → tree-sitter grammar directory name
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".rb": "ruby",
  ".java": "java",
  ".cs": "c_sharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".sql": "sql",
  ".php": "php",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml_interface",
  ".nim": "nim",
  ".zig": "zig",
  ".dart": "dart",
  ".r": "r",
  ".jl": "julia",
  ".pl": "perl",
  ".pm": "perl",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".prisma": "prisma",
  ".dockerfile": "dockerfile",
  ".cmake": "cmake",
  ".make": "make",
  ".nix": "nix",
  ".fish": "fish",
  ".ps1": "powershell",
  ".proto": "proto",
  ".tf": "terraform",
  ".hcl": "hcl",
  ".gleam": "gleam",
  ".solidity": "solidity",
  ".sol": "solidity",
  ".typ": "typst",
  ".latex": "latex",
  ".tex": "latex",
};

// Language name → cached Language object
const languageCache = new Map<string, any>();
let Parser: any = null;
let parserInitPromise: Promise<void> | null = null;

// ── Parser initialization ────────────────────────────────────────────────────

async function ensureParser(): Promise<void> {
  if (Parser) return;
  if (parserInitPromise) return parserInitPromise;

  parserInitPromise = (async () => {
    const wts = await import("web-tree-sitter");
    await wts.Parser.init();
    Parser = wts;
  })();
  await parserInitPromise;
}

async function getLanguage(langDir: string): Promise<any> {
  if (languageCache.has(langDir)) return languageCache.get(langDir);

  await ensureParser();

  const wasmPath = join(GRAMMAR_DIR, langDir, `tree-sitter-${langDir}.wasm`);
  if (!existsSync(wasmPath)) return null;

  const language = await Parser.Language.load(wasmPath);
  languageCache.set(langDir, language);
  return language;
}

function langForPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

// ── Diagnostics extraction ───────────────────────────────────────────────────

function extractDiagnostics(node: any, source: string): Diagnostic[] {
  const results: Diagnostic[] = [];

  function walk(n: any) {
    if (n.type === "ERROR") {
      const text = n.text.slice(0, 80).replace(/\n/g, "⏎");
      results.push({
        line: n.startPosition.row + 1,
        column: n.startPosition.column + 1,
        endLine: n.endPosition.row + 1,
        endColumn: n.endPosition.column + 1,
        message: `Syntax error: unexpected \`${text}\``,
        severity: "error",
        context: n.text.slice(0, 100),
      });
      return; // Don't recurse into ERROR nodes
    }

    // MISSING nodes: tree-sitter inserts these for expected-but-absent tokens
    if (n.isMissing) {
      const parentCtx = n.parent ? n.parent.type : "";
      results.push({
        line: n.startPosition.row + 1,
        column: n.startPosition.column + 1,
        endLine: n.endPosition.row + 1,
        endColumn: n.endPosition.column + 1,
        message: `Missing \`${n.type}\`${parentCtx ? ` in ${parentCtx}` : ""}`,
        severity: "error",
        context: "",
      });
      return;
    }

    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return results;
}

// ── Core parse function ──────────────────────────────────────────────────────

async function parseFile(filePath: string): Promise<{ diagnostics: Diagnostic[]; language: string } | null> {
  const langDir = langForPath(filePath);
  if (!langDir) return null;

  const language = await getLanguage(langDir);
  if (!language) return null;

  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return null; // File might have been deleted
  }

  await ensureParser();
  const parser = new Parser.Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);

  if (!tree.rootNode.hasError) {
    tree.delete();
    return { diagnostics: [], language: langDir };
  }

  const diagnostics = extractDiagnostics(tree.rootNode, source);
  tree.delete();
  return { diagnostics, language: langDir };
}

function formatDiagnostics(filePath: string, result: { diagnostics: Diagnostic[]; language: string }): string {
  const { diagnostics, language } = result;

  if (diagnostics.length === 0) {
    return `✅ ${filePath} — no syntax errors`;
  }

  const lines = diagnostics.map((d) => {
    const loc = d.line === d.endLine
      ? `L${d.line}:${d.column}`
      : `L${d.line}:${d.column}-${d.endLine}:${d.endColumn}`;
    const icon = d.severity === "error" ? "❌" : "⚠️";
    return `  ${icon} ${loc} — ${d.message}`;
  });

  const summary = diagnostics.length === 1
    ? "1 syntax error"
    : `${diagnostics.length} syntax errors`;

  return `🔍 ${filePath} (${language}): ${summary}\n${lines.join("\n")}`;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function piLspExtension(pi: ExtensionAPI) {
  let currentCwd = "";
  let parserReady = false;

  // ── Session lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;

    // 1. Ensure npm dependencies are installed
    const extDir = dirname(fileURLToPath(import.meta.url));
    // Walk up to find the package root (where node_modules should live)
    let pkgRoot = extDir;
    for (let i = 0; i < 3; i++) {
      if (existsSync(join(pkgRoot, "package.json"))) break;
      pkgRoot = join(pkgRoot, "..");
    }
    if (!existsSync(join(pkgRoot, "node_modules"))) {
      ctx.ui.setStatus("pi-lsp", "Installing deps...");
      const { execFile } = await import("node:child_process");
      const run = (await import("node:util")).promisify(execFile);
      try {
        await run("npm", ["install", "--omit=dev"], { cwd: pkgRoot, timeout: 120_000 });
        ctx.ui.notify("pi-lsp: Dependencies installed", "info");
      } catch (err: any) {
        ctx.ui.notify(`pi-lsp: npm install failed — ${err.message}`, "error");
        ctx.ui.setStatus("pi-lsp", "⚠ install failed");
        return;
      }
    }

    // 2. Eagerly init parser in background (don't block startup)
    ensureParser().then(() => {
      parserReady = true;
      ctx.ui.setStatus("pi-lsp", "● Ready");
      ctx.ui.notify("pi-lsp: Syntax diagnostics ready", "info");
    }).catch(() => {
      ctx.ui.setStatus("pi-lsp", "⚠ init failed");
    });
  });

  pi.on("session_shutdown", () => {
    parserReady = false;
  });

  // ── After-edit diagnostics ────────────────────────────────────────────────

  const FILE_MUTATING_TOOLS = new Set(["edit", "write", "bash"]);

  pi.on("tool_result", async (event, ctx) => {
    if (!FILE_MUTATING_TOOLS.has(event.toolName)) return;
    if (event.isError) return;
    if (!parserReady) return;

    // Resolve the file path that was mutated
    let filePath: string | undefined;

    if (event.toolName === "edit" || event.toolName === "write") {
      const input = event.input as { path?: string };
      if (input.path) {
        filePath = input.path.startsWith("/")
          ? input.path
          : resolve(currentCwd, input.path);
      }
    } else if (event.toolName === "bash") {
      // For bash, only check if the command likely wrote to a known file
      const cmd = (event.input as { command?: string })?.command ?? "";
      // Try to extract a file path from common patterns
      const writeMatch = cmd.match(/>\s*"?([^\s"']+)"?/) // > file or > "file"
        ?? cmd.match(/>>\s*"?([^\s"']+)"?/); // >> file
      if (writeMatch && writeMatch[1]) {
        filePath = writeMatch[1].startsWith("/")
          ? writeMatch[1]
          : resolve(currentCwd, writeMatch[1]);
      }
      // If no redirect, check if it's a language-aware command we can't trace
      // Skip — too noisy to re-parse the entire repo
      if (!filePath) return;
    }

    if (!filePath) return;

    // Check if we support this language
    const langDir = langForPath(filePath);
    if (!langDir) return;

    // Parse the file and extract diagnostics
    try {
      const result = await parseFile(filePath);
      if (!result) return;

      // Only notify the agent if there are actual errors
      if (result.diagnostics.length > 0) {
        const message = formatDiagnostics(filePath, result);

        pi.sendMessage({
          customType: "pi-lsp-diagnostics",
          content: message,
          display: true,
          details: { diagnostics: result.diagnostics, file: filePath, language: result.language },
        }, {
          deliverAs: "steer", // Delivered after current tool batch completes
        });
      }
    } catch {
      // Non-critical — diagnostics are best-effort
    }
  });

  // ── Manual diagnostics tool ───────────────────────────────────────────────

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "Syntax Diagnostics",
    description:
      "Check a file for syntax errors using tree-sitter. " +
      "Returns line/column of each error with a description. " +
      "Supports 80+ languages. Runs in-process, sub-millisecond. " +
      "This only checks SYNTAX errors (missing brackets, invalid tokens), not type errors.",
    promptSnippet: "Check a file for syntax errors",
    promptGuidelines: [
      "Use lsp_diagnostics to check for syntax errors after editing a file, especially when unsure if the edit introduced a mistake.",
      "lsp_diagnostics only catches syntax errors (missing brackets, invalid tokens), not type errors or logic errors.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path to check (absolute or relative to cwd)" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!parserReady) {
        return { content: [{ type: "text", text: "Parser not ready yet." }], details: {} };
      }

      const filePath = params.path.startsWith("/")
        ? params.path
        : resolve(ctx.cwd, params.path);

      if (!existsSync(filePath)) {
        return { content: [{ type: "text", text: `File not found: ${params.path}` }], details: {} };
      }

      const langDir = langForPath(filePath);
      if (!langDir) {
        return { content: [{ type: "text", text: `No tree-sitter grammar for file extension "${extname(filePath)}"` }], details: {} };
      }

      try {
        const result = await parseFile(filePath);
        if (!result) {
          return { content: [{ type: "text", text: `Could not parse ${params.path}` }], details: {} };
        }

        const message = formatDiagnostics(filePath, result);
        return {
          content: [{ type: "text", text: message }],
          details: { diagnostics: result.diagnostics, language: result.language, file: filePath },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Parse failed: ${err.message}` }], details: {} };
      }
    },
  });

  // ── Project-wide scan ─────────────────────────────────────────────────────

  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
    "__pycache__", ".next", ".nuxt", ".cache", ".parcel-cache", ".turbo",
    "coverage", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    "vendor", "Cargo.lock", ".dart_tool", ".gradle", ".idea", ".vscode",
  ]);

  const MAX_FILE_BYTES = 500_000; // skip files larger than 500KB
  const MAX_FILES = 2000;

  interface FileDiagnostic {
    path: string;
    language: string;
    diagnostics: Diagnostic[];
  }

  function collectFiles(root: string): string[] {
    const files: string[] = [];

    function walk(dir: string) {
      if (files.length >= MAX_FILES) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(full);
        } else if (entry.isFile()) {
          // Skip binary / huge files
          try {
            const stat = statSync(full);
            if (stat.size > MAX_FILE_BYTES) continue;
          } catch { continue; }

          const langDir = langForPath(full);
          if (langDir) files.push(full);
        }
      }
    }

    walk(root);
    return files;
  }

  async function scanProject(
    cwd: string,
    onUpdate?: (info: { scanned: number; total: number; errors: number }) => void,
    signal?: AbortSignal,
  ): Promise<FileDiagnostic[]> {
    const files = collectFiles(cwd);
    const total = files.length;
    const results: FileDiagnostic[] = [];
    let scanned = 0;
    let errorCount = 0;

    for (const filePath of files) {
      if (signal?.aborted) break;

      try {
        const result = await parseFile(filePath);
        scanned++;
        if (result && result.diagnostics.length > 0) {
          errorCount += result.diagnostics.length;
          results.push({
            path: relative(cwd, filePath) || filePath,
            language: result.language,
            diagnostics: result.diagnostics,
          });
        }
      } catch {
        scanned++;
      }

      onUpdate?.({ scanned, total, errors: errorCount });
    }

    return results;
  }

  function formatProjectResults(cwd: string, results: FileDiagnostic[], scanned: number, total: number): string {
    if (results.length === 0) {
      return `✅ Project clean — no syntax errors in ${scanned}/${total} files (${cwd})`;
    }

    const totalErrors = results.reduce((sum, r) => sum + r.diagnostics.length, 0);
    const lines: string[] = [
      `🔍 Project scan: ${totalErrors} syntax error(s) in ${results.length} file(s) (scanned ${scanned}/${total})`,
      "",
    ];

    for (const file of results) {
      for (const d of file.diagnostics) {
        const loc = d.line === d.endLine
          ? `L${d.line}:${d.column}`
          : `L${d.line}:${d.column}-${d.endLine}:${d.endColumn}`;
        const icon = d.severity === "error" ? "❌" : "⚠️";
        lines.push(`  ${icon} ${file.path}:${loc} — ${d.message}`);
      }
    }

    return lines.join("\n");
  }

  // ── Project diagnostics tool ────────────────────────────────────────────────

  pi.registerTool({
    name: "lsp_project_diagnostics",
    label: "Project Syntax Scan",
    description:
      "Scan the entire project for syntax errors using tree-sitter. " +
      "Walks all source files, parses each one, and reports files with errors. " +
      "Skips node_modules, .git, dist, build, vendor, etc. " +
      "Supports 80+ languages. Typical scan: ~1-5 seconds for most projects.",
    promptSnippet: "Scan the entire project for syntax errors",
    promptGuidelines: [
      "Use lsp_project_diagnostics when you need a project-wide syntax health check, such as after a large refactoring.",
      "Use lsp_diagnostics for a single file and lsp_project_diagnostics for the whole project.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to scan (default: cwd)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!parserReady) {
        return { content: [{ type: "text", text: "Parser not ready yet." }], details: {} };
      }

      const scanRoot = params.path
        ? (params.path.startsWith("/") ? params.path : resolve(ctx.cwd, params.path))
        : ctx.cwd;

      if (!existsSync(scanRoot)) {
        return { content: [{ type: "text", text: `Directory not found: ${params.path ?? "."}` }], details: {} };
      }

      let lastUpdate = 0;
      const results = await scanProject(scanRoot, (info) => {
        const now = Date.now();
        if (now - lastUpdate > 500) {
          lastUpdate = now;
          _onUpdate?.({
            content: [{ type: "text", text: `Scanning... ${info.scanned}/${info.total} files, ${info.errors} errors found` }],
          });
        }
      }, signal);

      const totalFiles = collectFiles(scanRoot).length;
      const message = formatProjectResults(scanRoot, results, totalFiles, totalFiles);

      return {
        content: [{ type: "text", text: message }],
        details: { filesWithErrors: results.length, totalErrors: results.reduce((s, r) => s + r.diagnostics.length, 0), results },
      };
    },
  });

  // ── File diagnostics tool (already registered above, keeping for clarity) ───
  // (lsp_diagnostics is registered above)

  // ── Commands ──────────────────────────────────────────────────────────────

  pi.registerCommand("lsp-status", {
    description: "Show pi-lsp status",
    handler: async (_args, ctx) => {
      const lines = ["pi-lsp v2 Status", ""];

      if (parserReady) {
        lines.push("Parser:   ✓ web-tree-sitter loaded");
        lines.push(`Grammars: ${languageCache.size} loaded, ${Object.keys(EXT_TO_LANG).length} supported`);
        lines.push(`Languages: ${[...new Set(Object.values(EXT_TO_LANG))].sort().join(", ")}`);
      } else {
        lines.push("Parser:   ⏳ loading...");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("lsp-check", {
    description: "Check a file or the whole project for syntax errors",
    getArgumentCompletions: (prefix: string) => {
      // Suggest common paths
      const suggestions = ["src/", "lib/", "packages/", "app/", "."];
      return suggestions
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s, description: s === "." ? "entire project" : `scan ${s}` }));
    },
    handler: async (args, ctx) => {
      if (!parserReady) {
        ctx.ui.notify("Parser not ready yet", "warning");
        return;
      }

      const target = args?.trim();

      // If a specific file is given, check just that file
      if (target && extname(target)) {
        const filePath = target.startsWith("/") ? target : resolve(ctx.cwd, target);
        if (!existsSync(filePath)) {
          ctx.ui.notify(`File not found: ${target}`, "error");
          return;
        }
        const result = await parseFile(filePath);
        if (!result) {
          ctx.ui.notify(`No grammar for ${extname(target)}`, "warning");
          return;
        }
        const msg = formatDiagnostics(filePath, result);
        ctx.ui.notify(msg, result.diagnostics.length > 0 ? "error" : "info");
        return;
      }

      // Otherwise scan the directory/project
      const scanRoot = target && target !== "."
        ? (target.startsWith("/") ? target : resolve(ctx.cwd, target))
        : ctx.cwd;

      ctx.ui.setStatus("pi-lsp", "Scanning...");
      const results = await scanProject(scanRoot);
      const totalFiles = collectFiles(scanRoot).length;
      ctx.ui.setStatus("pi-lsp", "● Ready");

      const msg = formatProjectResults(scanRoot, results, totalFiles, totalFiles);
      ctx.ui.notify(msg, results.length > 0 ? "error" : "info");
    },
  });

  pi.registerCommand("lsp-project", {
    description: "Scan the entire project for syntax errors",
    handler: async (_args, ctx) => {
      if (!parserReady) {
        ctx.ui.notify("Parser not ready yet", "warning");
        return;
      }

      ctx.ui.setStatus("pi-lsp", "Scanning project...");
      const results = await scanProject(ctx.cwd);
      const totalFiles = collectFiles(ctx.cwd).length;
      ctx.ui.setStatus("pi-lsp", "● Ready");

      const msg = formatProjectResults(ctx.cwd, results, totalFiles, totalFiles);
      ctx.ui.notify(msg, results.length > 0 ? "error" : "info");
    },
  });
}
