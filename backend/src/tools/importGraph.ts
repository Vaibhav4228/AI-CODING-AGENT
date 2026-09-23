import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { parse } from "@babel/parser";
import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import {
  getProjectRoot,
  resolveProjectPath,
} from "./shared/workingDir";

const AGENT_DIR = ".agent";
const GRAPH_FILE = "graph.json";

const GLOB_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/.agent/**",
];

function getContext(toolConfig: any) {
  const projectId = toolConfig.configurable?.projectId;
  const userId = toolConfig.configurable?.userId;

  if (!userId || !projectId) {
    throw new Error("Missing userId or projectId in tool configuration.");
  }

  return { userId, projectId, projectRoot: getProjectRoot(userId, projectId) };
}

function getGraphPath(projectRoot: string) {
  return path.join(projectRoot, AGENT_DIR, GRAPH_FILE);
}

function resolveImport(fromFile: string, importPath: string) {
  if (!importPath.startsWith(".")) return null;
  const fromDir = path.dirname(fromFile);
  const resolved = path.join(fromDir, importPath);
  return resolved.replace(/\\/g, "/");
}

function resolveToActualFile(importedPath: string, allFiles: Set<string>) {
  const extensions = [
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    "/index.js",
    "/index.ts",
    "/index.jsx",
    "/index.tsx",
  ];

  if (allFiles.has(importedPath)) return importedPath;

  for (const ext of extensions) {
    const candidate = importedPath + ext;
    if (allFiles.has(candidate)) return candidate;
  }

  return null;
}

function extractImports(content: string, ext: string) {
  const isTS = [".ts", ".tsx"].includes(ext);
  const isJSX = [".jsx", ".tsx"].includes(ext);

  try {
    const ast = parse(content, {
      sourceType: "module",
      errorRecovery: true,
      plugins: [
        ...(isTS ? ["typescript"] : []),
        ...(isJSX ? ["jsx"] : []),
        "decorators-legacy",
        "classProperties",
        "importMeta",
        "topLevelAwait",
      ] as any,
    });

    const imports: string[] = [];

    for (const node of ast.program.body) {
      if (node.type === "ImportDeclaration") {
        imports.push(node.source.value);
      }

      if (
        (node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source
      ) {
        imports.push(node.source.value);
      }

      if (node.type === "ExpressionStatement") {
        const expr: any = node.expression;
        if (
          expr?.type === "CallExpression" &&
          expr.callee?.name === "require" &&
          expr.arguments?.[0]?.type === "StringLiteral"
        ) {
          imports.push(expr.arguments[0].value);
        }
      }
    }

    return imports;
  } catch {
    return [];
  }
}

async function buildGraph(projectRoot: string, files: string[]) {
  const normalized = files.map((file) => file.replace(/\\/g, "/"));
  const fileSet = new Set(normalized);
  const graph: Record<
    string,
    { imports: string[]; importedBy: string[]; unresolvedImports: string[] }
  > = {};

  for (const file of normalized) {
    graph[file] = { imports: [], importedBy: [], unresolvedImports: [] };
  }

  for (const file of normalized) {
    let content: string;
    try {
      content = await fs.readFile(path.join(projectRoot, file), "utf-8");
    } catch {
      continue;
    }

    const rawImports = extractImports(content, path.extname(file));

    for (const imp of rawImports) {
      if (!imp.startsWith(".")) {
        graph[file].unresolvedImports.push(imp);
        continue;
      }

      const relativePath = resolveImport(file, imp)?.replace(/\\/g, "/");
      if (!relativePath) continue;

      const actualFile = resolveToActualFile(relativePath, fileSet);
      if (actualFile) {
        if (!graph[file].imports.includes(actualFile)) {
          graph[file].imports.push(actualFile);
        }
        if (!graph[actualFile].importedBy.includes(file)) {
          graph[actualFile].importedBy.push(file);
        }
      } else {
        graph[file].unresolvedImports.push(imp);
      }
    }
  }

  return graph;
}

function analyzeGraph(graph: Record<string, any>) {
  const entryPoints: string[] = [];
  const isolated: string[] = [];
  const central: { file: string; importedBy: number }[] = [];

  for (const [file, node] of Object.entries(graph)) {
    const importedByCount = node.importedBy.length;
    const importsCount = node.imports.length;

    if (importedByCount === 0 && importsCount > 0) entryPoints.push(file);
    if (importedByCount === 0 && importsCount === 0) isolated.push(file);
    if (importedByCount >= 3) {
      central.push({ file, importedBy: importedByCount });
    }
  }

  central.sort((a, b) => b.importedBy - a.importedBy);

  return {
    totalFiles: Object.keys(graph).length,
    entryPoints,
    isolated,
    mostImported: central.slice(0, 10),
  };
}

async function loadGraph(projectRoot: string) {
  const raw = await fs.readFile(getGraphPath(projectRoot), "utf-8");
  return JSON.parse(raw) as {
    graph: Record<string, any>;
    summary?: any;
    builtAt?: string;
  };
}

function findGraphTarget(graph: Record<string, any>, filePath: string) {
  if (graph[filePath]) return filePath;

  const normalized = filePath.replace(/\\/g, "/");
  if (graph[normalized]) return normalized;

  return Object.keys(graph).find(
    (key) =>
      key.includes(normalized) ||
      normalized.includes(path.basename(key, path.extname(key)))
  );
}

export const buildImportGraphTool = tool(
  async ({ directory, file_pattern }, toolConfig: any) => {
    try {
      const { userId, projectId, projectRoot } = getContext(toolConfig);

      const base = directory
        ? resolveProjectPath(userId, projectId, directory)
        : projectRoot;

      const pattern = file_pattern ?? "**/*.{js,ts,jsx,tsx}";
      const files = await glob(pattern, {
        cwd: base,
        ignore: GLOB_IGNORE,
        nodir: true,
        absolute: false,
      });

      const relFiles = (
        directory
          ? files.map((file) => path.join(directory, file))
          : files
      ).map((file) => file.replace(/\\/g, "/"));

      if (!relFiles.length) {
        return `No JS/TS files found matching "${pattern}"`;
      }

      const graph = await buildGraph(projectRoot, relFiles);
      const summary = analyzeGraph(graph);

      const agentDir = path.join(projectRoot, AGENT_DIR);
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        getGraphPath(projectRoot),
        JSON.stringify(
          { graph, summary, builtAt: new Date().toISOString() },
          null,
          2
        ),
        "utf-8"
      );

      return [
        `Import graph built — ${summary.totalFiles} files`,
        ``,
        `Entry points (${summary.entryPoints.length}):`,
        ...summary.entryPoints.slice(0, 10).map((file) => `  ${file}`),
        ``,
        `Most imported (high centrality):`,
        ...summary.mostImported.map(
          (item) => `  ${item.file}  ← ${item.importedBy} files`
        ),
        ``,
        summary.isolated.length
          ? `Isolated (${summary.isolated.length}): ${summary.isolated
              .slice(0, 5)
              .join(", ")}`
          : `No isolated files`,
        ``,
        `Saved to .agent/graph.json`,
      ].join("\n");
    } catch (error: any) {
      return `Import graph error: ${error.message}`;
    }
  },
  {
    name: "build_import_graph",
    description:
      "Build a full bidirectional import dependency graph for all JS/TS files. " +
      "Identifies entry points, most-imported files, and isolated (potentially dead) files. " +
      "Saved to .agent/graph.json. Run once per session on a new project.",
    schema: z.object({
      directory: z
        .string()
        .optional()
        .describe("Subdirectory to scan (default: full project)"),
      file_pattern: z
        .string()
        .optional()
        .describe("Glob pattern (default: **/*.{js,ts,jsx,tsx})"),
    }),
  }
);

export const queryImportGraphTool = tool(
  async ({ file_path, direction, depth }, toolConfig: any) => {
    try {
      const { projectRoot } = getContext(toolConfig);
      const { graph } = await loadGraph(projectRoot);
      const target = findGraphTarget(graph, file_path);

      if (!target) {
        return `"${file_path}" not found in graph. Run build_import_graph first.`;
      }

      const node = graph[target];
      const dir = direction ?? "both";
      const dep = Math.min(Math.max(depth ?? 1, 1), 3);
      const lines = [`${target}`];

      if (dir === "imports" || dir === "both") {
        lines.push(`\nImports (${node.imports.length}):`);
        for (const dependency of node.imports) {
          lines.push(`  → ${dependency}`);
          if (dep > 1) {
            for (const nested of graph[dependency]?.imports ?? []) {
              lines.push(`      → ${nested}`);
            }
          }
        }
        if (node.unresolvedImports?.length) {
          lines.push(
            `\nExternal: ${node.unresolvedImports.slice(0, 8).join(", ")}`
          );
        }
      }

      if (dir === "importedBy" || dir === "both") {
        lines.push(`\nImported by (${node.importedBy.length}):`);
        for (const dependent of node.importedBy) {
          lines.push(`  ← ${dependent}`);
          if (dep > 1) {
            for (const nested of graph[dependent]?.importedBy ?? []) {
              lines.push(`      ← ${nested}`);
            }
          }
        }
      }

      return lines.join("\n");
    } catch {
      return "No graph found. Run build_import_graph first.";
    }
  },
  {
    name: "query_import_graph",
    description:
      "Look up a file in the import graph — shows its imports, what imports it, and external deps. " +
      "Use before editing to understand impact. Requires build_import_graph to have run.",
    schema: z.object({
      file_path: z
        .string()
        .describe("File path relative to project root"),
      direction: z.enum(["imports", "importedBy", "both"]).optional(),
      depth: z
        .number()
        .optional()
        .describe("Traversal depth (default 1, max 3)"),
    }),
  }
);

export const impactAnalysisTool = tool(
  async ({ file_path }, toolConfig: any) => {
    try {
      const { projectRoot } = getContext(toolConfig);
      const { graph } = await loadGraph(projectRoot);
      const target = findGraphTarget(graph, file_path);

      if (!target) {
        return `"${file_path}" not found. Run build_import_graph first.`;
      }

      const visited = new Set<string>();
      const levels: Record<string, number> = {};
      let queue = [target];
      let level = 0;

      while (queue.length && level <= 10) {
        const next: string[] = [];
        for (const file of queue) {
          if (visited.has(file)) continue;
          visited.add(file);
          levels[file] = level;
          for (const dep of graph[file]?.importedBy ?? []) {
            if (!visited.has(dep)) next.push(dep);
          }
        }
        queue = next;
        level++;
      }

      visited.delete(target);
      if (!visited.size) {
        return `${target} — no dependents. Safe to change.`;
      }

      const byLevel: Record<string, string[]> = {};
      for (const [file, lvl] of Object.entries(levels)) {
        if (file === target) continue;
        (byLevel[lvl] = byLevel[lvl] ?? []).push(file);
      }

      const lines = [
        `Impact analysis: ${target}`,
        `   ${visited.size} file(s) affected\n`,
      ];

      for (const [lvl, files] of Object.entries(byLevel)) {
        lines.push(
          `${lvl === "1" ? "Direct" : `Transitive depth ${lvl}`} (${files.length}):`
        );
        files.forEach((file) => lines.push(`  ${file}`));
        lines.push("");
      }

      return lines.join("\n");
    } catch {
      return "No graph found. Run build_import_graph first.";
    }
  },
  {
    name: "impact_analysis",
    description:
      "Find ALL files affected if a given file changes — direct and transitive dependents. " +
      "Use before refactoring. Answers: what breaks if I change this?",
    schema: z.object({
      file_path: z
        .string()
        .describe("File to analyze (relative to project root)"),
    }),
  }
);

export const graphTools = [
  buildImportGraphTool,
  queryImportGraphTool,
  impactAnalysisTool,
];

export const selectedGraphTool = {
  build_import_graph: buildImportGraphTool,
  query_import_graph: queryImportGraphTool,
  impact_analysis: impactAnalysisTool,
} as Record<string, any>;
