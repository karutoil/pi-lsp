/**
 * typecheck.ts — Run language-specific type checkers/compilers.
 * Detects project type, runs appropriate command, parses output into diagnostics.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ──

export interface TypeCheckCommand {
  command: string;
  args: string[];
  description: string;
}

export interface TypeCheckResult {
  projectType: string | null;
  command: string;
  diagnostics: Diagnostic[];
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  stdout: string;
  stderr: string;
}

interface Diagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: "error" | "warning";
  context: string;
}

// ── Project detection ──

const PROJECT_CONFIGS: Array<{ file: string; type: string }> = [
  { file: "tsconfig.json", type: "typescript" },
  { file: "Cargo.toml", type: "rust" },
  { file: "go.mod", type: "go" },
  { file: "pyproject.toml", type: "python" },
  { file: "setup.py", type: "python" },
  { file: "setup.cfg", type: "python" },
  { file: "Pipfile", type: "python" },
  { file: "pom.xml", type: "java-maven" },
  { file: "build.gradle", type: "java-gradle" },
  { file: "build.gradle.kts", type: "java-gradle" },
  { file: "settings.gradle", type: "java-gradle" },
  { file: "CMakeLists.txt", type: "cpp-cmake" },
  { file: "Makefile", type: "cpp-make" },
  { file: "Gemfile", type: "ruby" },
  { file: "composer.json", type: "php" },
  { file: "mix.exs", type: "elixir" },
  { file: "Package.swift", type: "swift" },
  { file: "build.zig", type: "zig" },
  { file: "stack.yaml", type: "haskell" },
  { file: "cabal.project", type: "haskell" },
  { file: "build.sbt", type: "scala" },
  { file: "Cask", type: "ruby" },
  { file: "dub.json", type: "dart" },
  { file: "dub.sdl", type: "dart" },
  { file: "shard.yml", type: "ruby" }, // Crystal-like
  { file: "meson.build", type: "cpp-meson" },
  { file: "BUCK", type: "cpp-generic" },
  { file: "WORKSPACE", type: "cpp-bazel" },
  { file: "BUILD.bazel", type: "cpp-bazel" },
  { file: "package.json", type: "javascript" }, // last — many projects include this
];

export function detectProjectType(cwd: string): string | null {
  for (const { file, type } of PROJECT_CONFIGS) {
    if (existsSync(join(cwd, file))) return type;
  }
  return null;
}

// ── Check commands per project type ──

const CHECK_COMMANDS: Record<string, TypeCheckCommand[]> = {
  typescript: [
    { command: "npx", args: ["tsc", "--noEmit"], description: "TypeScript compiler (npx)" },
    { command: "tsc", args: ["--noEmit"], description: "TypeScript compiler (global)" },
  ],
  javascript: [
    { command: "npx", args: ["eslint", ".", "--format", "unix"], description: "ESLint" },
  ],
  rust: [
    { command: "cargo", args: ["check", "--message-format", "short"], description: "Cargo check" },
  ],
  go: [
    { command: "go", args: ["build", "./..."], description: "Go build" },
    { command: "go", args: ["vet", "./..."], description: "Go vet" },
  ],
  python: [
    { command: "ruff", args: ["check", "--output-format", "full"], description: "Ruff linter" },
    { command: "mypy", args: ["."], description: "Mypy type checker" },
  ],
  "java-maven": [
    { command: "mvn", args: ["compile", "-q"], description: "Maven compile" },
  ],
  "java-gradle": [
    { command: "gradle", args: ["compileJava", "-q"], description: "Gradle compile" },
  ],
  "cpp-cmake": [
    { command: "cmake", args: ["--build", "build"], description: "CMake build" },
    { command: "make", args: ["-k"], description: "Make fallback" },
  ],
  "cpp-make": [
    { command: "make", args: ["-k"], description: "Make" },
  ],
  "cpp-meson": [
    { command: "meson", args: ["compile", "-C", "builddir"], description: "Meson compile" },
  ],
  "cpp-bazel": [
    { command: "bazel", args: ["build", "//..."], description: "Bazel build" },
  ],
  "cpp-generic": [
    { command: "make", args: ["-k"], description: "Make" },
  ],
  ruby: [
    { command: "ruby", args: ["-c"], description: "Ruby syntax check" },
  ],
  php: [
    { command: "php", args: ["-l"], description: "PHP lint" },
  ],
  elixir: [
    { command: "mix", args: ["compile", "--no-deps-check"], description: "Elixir compile" },
  ],
  haskell: [
    { command: "stack", args: ["build", "--no-test", "--no-bench"], description: "Stack build" },
    { command: "cabal", args: ["build"], description: "Cabal build" },
  ],
  scala: [
    { command: "sbt", args: ["compile"], description: "SBT compile" },
  ],
  swift: [
    { command: "swift", args: ["build"], description: "Swift build" },
  ],
  zig: [
    { command: "zig", args: ["build"], description: "Zig build" },
  ],
  dart: [
    { command: "dart", args: ["analyze"], description: "Dart analyzer" },
  ],
};

export function getCheckCommands(projectType: string): TypeCheckCommand[] {
  return CHECK_COMMANDS[projectType] ?? [];
}

// ── Output parsing ──

/** tsc: `src/file.ts(10,5): error TS2322: message` */
function parseTscOutput(text: string): Diagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+)?:?\s*(.+)/gm;
  const results: Diagnostic[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [, , line, col, severity, , message] = match;
    results.push({
      line: parseInt(line),
      column: parseInt(col),
      endLine: parseInt(line),
      endColumn: parseInt(col) + 1,
      message: message.trim(),
      severity: severity as "error" | "warning",
      context: "",
    });
  }
  return results;
}

/** gcc / go / clang / eslint-unix / ruff: `file:line:col: error: message` */
function parseGccStyle(text: string): Diagnostic[] {
  const re = /^([^:\s]+?):(\d+):(\d+):\s*(error|warning|note)?\s*\[?([^\]]*?)\]?\s*:?\s*(.+)/gm;
  const results: Diagnostic[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [, , line, col, sev, code, message] = match;
    const severity = sev === "warning" || sev === "note" ? "warning" : "error";
    const codeStr = code ? `[${code}] ` : "";
    results.push({
      line: parseInt(line),
      column: parseInt(col),
      endLine: parseInt(line),
      endColumn: parseInt(col) + 1,
      message: `${codeStr}${message.trim()}`,
      severity,
      context: "",
    });
  }
  return results;
}

/** cargo long: `error[E0308]: ... \n  --> file:line:col` */
function parseCargoLong(text: string): Diagnostic[] {
  const results: Diagnostic[] = [];
  const lines = text.split("\n");
  let currentMessage = "";

  for (const line of lines) {
    if (/^(error|warning)\[/.test(line)) {
      currentMessage = line.trim();
    }

    const loc = line.match(/^-->\s*(.+?):(\d+):(\d+)/);
    if (loc) {
      const [, , lineNum, col] = loc;
      results.push({
        line: parseInt(lineNum),
        column: parseInt(col),
        endLine: parseInt(lineNum),
        endColumn: parseInt(col) + 1,
        message: currentMessage || line.trim(),
        severity: currentMessage.startsWith("warning") ? "warning" : "error",
        context: "",
      });
      currentMessage = "";
    }
  }

  return results;
}

/** Python traceback: `  File "path", line N` */
function parsePythonTraceback(text: string): Diagnostic[] {
  const results: Diagnostic[] = [];
  const re = /File\s+"(.+?)",\s+line\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [, , lineNum] = match;
    results.push({
      line: parseInt(lineNum),
      column: 1,
      endLine: parseInt(lineNum),
      endColumn: 2,
      message: "Syntax error",
      severity: "error",
      context: "",
    });
  }
  return results;
}

export function parseOutput(stdout: string, stderr: string, _projectType: string): Diagnostic[] {
  const combined = stderr + "\n" + stdout;

  // Try parsers in order — first to match wins
  let diags = parseTscOutput(combined);
  if (diags.length > 0) return diags;

  diags = parseCargoLong(combined);
  if (diags.length > 0) return diags;

  diags = parseGccStyle(combined);
  if (diags.length > 0) return diags;

  diags = parsePythonTraceback(combined);
  if (diags.length > 0) return diags;

  return [];
}

// ── Run check ──

export async function runTypeCheck(
  cwd: string,
  options?: { timeout?: number; command?: string; args?: string[] },
): Promise<TypeCheckResult> {
  const projectType = detectProjectType(cwd);

  let commands: TypeCheckCommand[];
  if (options?.command) {
    commands = [{ command: options.command, args: options.args ?? [], description: "custom" }];
  } else {
    commands = getCheckCommands(projectType ?? "");
  }

  if (commands.length === 0) {
    const msg = projectType
      ? `No check command configured for "${projectType}". Use a custom command.`
      : "No project type detected. Use a custom command (e.g. --command tsc --args --noEmit).";
    return {
      projectType,
      command: "",
      diagnostics: [],
      exitCode: null,
      timedOut: false,
      error: msg,
      stdout: "",
      stderr: "",
    };
  }

  const timeoutMs = (options?.timeout ?? 60) * 1000;

  for (const cmd of commands) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd.command, cmd.args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });

      const diagnostics = parseOutput(stdout, stderr, projectType ?? "");

      return {
        projectType,
        command: `${cmd.command} ${cmd.args.join(" ")}`,
        diagnostics,
        exitCode: 0,
        timedOut: false,
        stdout,
        stderr,
      };
    } catch (err: any) {
      // Command failed or timed out
      if (err.killed && err.signal === "SIGTERM") {
        return {
          projectType,
          command: `${cmd.command} ${cmd.args.join(" ")}`,
          diagnostics: [],
          exitCode: null,
          timedOut: true,
          error: `Timed out after ${options?.timeout ?? 60}s`,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
        };
      }

      const stdout = err.stdout ?? "";
      const stderr = err.stderr ?? "";
      const diagnostics = parseOutput(stdout, stderr, projectType ?? "");

      // If diagnostics found, report them even though exit code != 0
      if (diagnostics.length > 0) {
        return {
          projectType,
          command: `${cmd.command} ${cmd.args.join(" ")}`,
          diagnostics,
          exitCode: err.code ?? 1,
          timedOut: false,
          stdout,
          stderr,
        };
      }

      // Command not found → try next fallback
      if (
        err.code === "ENOENT" ||
        stderr.includes("not found") ||
        stderr.includes("not recognized")
      ) {
        continue;
      }

      // Unknown failure → report and stop
      const errText = stderr.split("\n").slice(0, 5).join("\n") || stdout.slice(0, 400);
      return {
        projectType,
        command: `${cmd.command} ${cmd.args.join(" ")}`,
        diagnostics,
        exitCode: err.code ?? 1,
        timedOut: false,
        error: errText,
        stdout,
        stderr,
      };
    }
  }

  // All fallbacks exhausted
  const tried = commands.map((c) => c.command).join(", ");
  return {
    projectType,
    command: tried,
    diagnostics: [],
    exitCode: null,
    timedOut: false,
    error: `None of the check commands (${tried}) are installed. Install one to enable type checking.`,
    stdout: "",
    stderr: "",
  };
}
