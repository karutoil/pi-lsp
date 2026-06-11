/**
 * queries.ts — Symbol extraction, references, hover, folding, and project-wide symbol index.
 * Uses imperative tree walking with heuristics. Works for all 80+ tree-sitter languages.
 */

// Minimal tree-sitter type shapes (avoids static import issues with WASM module)
interface Point {
  row: number;
  column: number;
}

interface SyntaxNode {
  type: string;
  text: string;
  startPosition: Point;
  endPosition: Point;
  parent: SyntaxNode | null;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName?(fieldName: string): SyntaxNode | null;
  descendantForPosition(pos: Point): SyntaxNode;
  namedDescendantForPosition(pos: Point): SyntaxNode;
}

interface Tree {
  rootNode: SyntaxNode;
  delete(): void;
}

// ── Types ──

export interface SymbolInfo {
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  nodeType: string;
  scope: string;
  containerName?: string;
}

export interface RefInfo {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  context: string;
}

export interface FoldingRange {
  startLine: number;
  endLine: number;
  kind: string;
}

// ── Definition classification ──

const KIND_PREFIXES: Record<string, string> = {
  function: "function",
  method: "method",
  class: "class",
  struct: "class",
  interface: "interface",
  trait: "interface",
  enum: "enum",
  type: "type",
  module: "module",
  namespace: "module",
  package: "module",
  variable: "variable",
  const: "constant",
  constant: "constant",
  parameter: "parameter",
  field: "field",
  property: "property",
  constructor: "constructor",
  import: "import",
  export: "module",
  label: "label",
};

export function classifyNode(type: string): string | null {
  if (!type || typeof type !== "string") return null;

  // Direct match
  if (KIND_PREFIXES[type]) return KIND_PREFIXES[type];

  // Prefix match: function_declaration → function
  for (const [key, kind] of Object.entries(KIND_PREFIXES)) {
    if (type.startsWith(key + "_")) return kind;
    if (type.endsWith("_" + key)) return kind;
  }

  // _definition / _declaration / _item / _spec suffixes
  for (const suffix of ["_definition", "_declaration", "_item", "_spec", "_statement"]) {
    if (type.endsWith(suffix)) {
      const base = type.slice(0, -suffix.length);
      if (KIND_PREFIXES[base]) return KIND_PREFIXES[base];
      return base; // unknown but likely a definition
    }
  }

  return null;
}

// ── Scope helpers ──

function findScopeName(node: SyntaxNode): string {
  let current = node.parent;
  while (current) {
    const kind = classifyNode(current.type);
    const nameNode = current.childForFieldName?.("name");
    if (kind && nameNode) return `${kind}:${nameNode.text}`;
    current = current.parent;
  }
  return "";
}

function findContainerName(node: SyntaxNode): string | undefined {
  let current = node.parent;
  while (current) {
    const nameNode = current.childForFieldName?.("name");
    if (nameNode && classifyNode(current.type)) return nameNode.text;
    current = current.parent;
  }
  return undefined;
}

// ── Symbol extraction ──

export function extractSymbols(tree: Tree, filePath: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function walk(node: SyntaxNode) {
    if (!node || typeof node.type !== "string") return;
    const kind = classifyNode(node.type);

    if (kind) {
      const nameNode = node.childForFieldName?.("name");
      if (nameNode) {
        const name = nameNode.text.trim();
        if (
          name.length > 0 &&
          name.length <= 200 &&
          !name.includes("\n") &&
          !name.includes(" ")
        ) {
          symbols.push({
            name,
            kind,
            file: filePath,
            line: nameNode.startPosition.row + 1,
            column: nameNode.startPosition.column + 1,
            endLine: nameNode.endPosition.row + 1,
            endColumn: nameNode.endPosition.column + 1,
            nodeType: node.type,
            scope: findScopeName(node),
            containerName: findContainerName(node),
          });
        }
      }
    }

    for (const child of node.namedChildren) walk(child);
  }

  walk(tree.rootNode);
  return symbols;
}

// ── Reference extraction ──

const IDENTIFIER_LIKE = new Set([
  "identifier",
  "name",
  "property_identifier",
  "type_identifier",
  "field_identifier",
  "package_identifier",
  "unit_identifier",
  "constant_identifier",
]);

function isIdentifierNode(node: SyntaxNode): boolean {
  return (
    IDENTIFIER_LIKE.has(node.type) || node.type.endsWith("_identifier") || node.type === "name"
  );
}

export function extractReferences(tree: Tree, targetName: string): RefInfo[] {
  const refs: RefInfo[] = [];

  function walk(node: SyntaxNode) {
    if (isIdentifierNode(node) && node.text === targetName) {
      const parent = node.parent;
      refs.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        endLine: node.endPosition.row + 1,
        endColumn: node.endPosition.column + 1,
        text: node.text,
        context: parent ? parent.type : "",
      });
      return;
    }
    for (const child of node.namedChildren) walk(child);
  }

  walk(tree.rootNode);
  return refs;
}

// ── Local definition resolution ──

export function resolveLocalDefinition(
  tree: Tree,
  targetLine: number,
  targetCol: number,
): SymbolInfo | null {
  const node = tree.rootNode.namedDescendantForPosition({
    row: targetLine - 1,
    column: targetCol - 1,
  });

  if (!node || !isIdentifierNode(node)) return null;

  const name = node.text;
  if (!name) return null;

  const symbols = extractSymbols(tree, "<local>");
  const refScope = findScopeName(node);

  // Exact scope match
  const exact = symbols.find((s) => s.name === name && s.scope === refScope);
  if (exact) return exact;

  // File-wide name match (first found)
  return symbols.find((s) => s.name === name) ?? null;
}

// ── Hover ──

export function getHoverInfo(tree: Tree, line: number, col: number): string | null {
  const node = tree.rootNode.descendantForPosition({
    row: line - 1,
    column: col - 1,
  });

  if (!node) return null;

  const lines: string[] = [];

  // 1. Node type
  lines.push(`**${node.type}**`);

  // 2. Snippet
  const text = node.text.slice(0, 200);
  if (text) lines.push(`\`\`\`\n${text}\n\`\`\``);

  // 3. If it's a definition, show kind + name
  const kind = classifyNode(node.type);
  if (kind) {
    const nameNode = node.childForFieldName?.("name");
    if (nameNode) {
      lines.push(`${kind}: \`${nameNode.text}\``);
    }
  }

  return lines.join("\n");
}

// ── Folding ranges ──

const FOLDABLE = new Set([
  "function_definition",
  "function_declaration",
  "method_definition",
  "class_definition",
  "class_declaration",
  "if_statement",
  "if_expression",
  "for_statement",
  "for_expression",
  "while_statement",
  "while_expression",
  "loop_statement",
  "match_expression",
  "match_statement",
  "switch_statement",
  "switch_expression",
  "try_statement",
  "catch_clause",
  "block",
  "statement_block",
  "code_block",
  "array",
  "object",
  "dictionary",
  "table",
  "tuple",
  "list",
]);

export function getFoldingRanges(tree: Tree): FoldingRange[] {
  const folds: FoldingRange[] = [];

  function walk(node: SyntaxNode) {
    const span = node.endPosition.row - node.startPosition.row;

    if (span >= 1) {
      const isFoldable =
        FOLDABLE.has(node.type) ||
        node.type.endsWith("_block") ||
        node.type.endsWith("_body") ||
        node.type.endsWith("_expression") ||
        (node.type === "comment" && span >= 2);

      if (isFoldable) {
        folds.push({
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          kind: node.type,
        });
      }
    }

    for (const child of node.namedChildren) walk(child);
  }

  walk(tree.rootNode);
  return folds;
}

// ── Symbol Index ──

export class SymbolIndex {
  private byName = new Map<string, SymbolInfo[]>();
  private byFile = new Map<string, SymbolInfo[]>();
  private fileTrees = new Map<string, Tree>();

  indexFile(filePath: string, tree: Tree): void {
    const symbols = extractSymbols(tree, filePath);

    // Remove old entries for this file
    for (const [name, entries] of this.byName) {
      const filtered = entries.filter((s) => s.file !== filePath);
      if (filtered.length === 0) {
        this.byName.delete(name);
      } else {
        this.byName.set(name, filtered);
      }
    }

    // Add new entries
    for (const sym of symbols) {
      const list = this.byName.get(sym.name) ?? [];
      list.push(sym);
      this.byName.set(sym.name, list);
    }

    this.byFile.set(filePath, symbols);

    // Replace cached tree
    const oldTree = this.fileTrees.get(filePath);
    if (oldTree && oldTree !== tree) {
      try { oldTree.delete(); } catch { /* ignore */ }
    }
    this.fileTrees.set(filePath, tree);
  }

  invalidateFile(filePath: string): void {
    for (const [name, entries] of this.byName) {
      const filtered = entries.filter((s) => s.file !== filePath);
      if (filtered.length === 0) {
        this.byName.delete(name);
      } else {
        this.byName.set(name, filtered);
      }
    }
    this.byFile.delete(filePath);

    const tree = this.fileTrees.get(filePath);
    if (tree) {
      try { tree.delete(); } catch { /* ignore */ }
      this.fileTrees.delete(filePath);
    }
  }

  findDefinitions(name: string): SymbolInfo[] {
    return this.byName.get(name) ?? [];
  }

  getFileSymbols(filePath: string): SymbolInfo[] {
    return this.byFile.get(filePath) ?? [];
  }

  getTree(filePath: string): Tree | undefined {
    return this.fileTrees.get(filePath);
  }

  allSymbols(): SymbolInfo[] {
    const all: SymbolInfo[] = [];
    for (const syms of this.byName.values()) all.push(...syms);
    return all;
  }

  findCompletions(prefix: string, limit = 40): SymbolInfo[] {
    const results: SymbolInfo[] = [];
    for (const [name, symbols] of this.byName) {
      if (name.startsWith(prefix)) {
        results.push(...symbols);
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }

  getFileCount(): number {
    return this.byFile.size;
  }

  getSymbolCount(): number {
    return this.byName.size;
  }

  clear(): void {
    for (const tree of this.fileTrees.values()) {
      try { tree.delete(); } catch { /* ignore */ }
    }
    this.byName.clear();
    this.byFile.clear();
    this.fileTrees.clear();
  }
}
