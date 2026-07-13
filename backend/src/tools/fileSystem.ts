import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import {
  getProjectRoot,
  resolveProjectPath,
} from "./shared/workingDir";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  "__pycache__",
  ".turbo",
  "out",
]);

const GLOB_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
];

const MAX_READ_BYTES = 512 * 1024;

function getContext(toolConfig: any) {
  const projectId = toolConfig.configurable?.projectId;
  const userId = toolConfig.configurable?.userId;

  if (!userId || !projectId) {
    throw new Error("Missing userId or projectId in tool configuration.");
  }

  return { userId, projectId };
}

function resolveFilePath(userId: string, projectId: string, filePath: string) {
  return resolveProjectPath(userId, projectId, filePath);
}

async function readTextFile(resolvedPath: string) {
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `File too large (${stat.size} bytes). Max allowed is ${MAX_READ_BYTES} bytes.`
    );
  }

  return fs.readFile(resolvedPath, "utf8");
}

function emitWriter(toolConfig: any, payload: Record<string, unknown>) {
  if (typeof toolConfig?.writer === "function") {
    toolConfig.writer(payload);
  }
}

export const read_file = tool(
  async ({ filename, offset = 0, limit = 100 }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const resolvedPath = resolveFilePath(userId, projectId, filename);
      const content = await readTextFile(resolvedPath);
      const lines = content.split("\n");
      const slice = lines.slice(offset, offset + limit);

      const formatted = slice
        .map((line, i) => `${String(offset + i + 1).padStart(4)} | ${line}`)
        .join("\n");

      emitWriter(toolConfig, {
        read_file: "read_file",
        filename,
        content: slice.join("\n"),
      });

      if (offset + limit < lines.length) {
        const remaining = lines.length - (offset + limit);
        return `${formatted}\n\n[... ${remaining} more lines. Use offset=${offset + limit} to continue reading ...]`;
      }

      return formatted;
    } catch (error: any) {
      return `Error reading file: ${error.message}`;
    }
  },
  {
    name: "read_file",
    description:
      "Read a file inside the project sandbox with line numbers. Supports offset/limit pagination.",
    schema: z.object({
      filename: z.string().describe("File path relative to project root"),
      offset: z.number().optional().default(0),
      limit: z.number().optional().default(100),
    }),
  }
);

export const write_file = tool(
  async ({ filename, content }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const fullPath = resolveFilePath(userId, projectId, filename);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");

      emitWriter(toolConfig, {
        write_file: "write_file",
        file_path: filename,
        content,
      });

      return JSON.stringify({
        message: `Successfully wrote to ${filename}. Characters: ${content.length}`,
      });
    } catch (error: any) {
      return `Error writing file: ${error.message}`;
    }
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file inside the project sandbox. Parent folders are created automatically.",
    schema: z.object({
      filename: z.string().describe("Target file path relative to project root"),
      content: z.string().describe("Full file content to write"),
    }),
  }
);

export const edit_file = tool(
  async ({ filename, old_str, new_str, replace_all = false }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const resolvedPath = resolveFilePath(userId, projectId, filename);
      const content = await readTextFile(resolvedPath);

      if (!content.includes(old_str)) {
        return `Error: Exact match for 'old_str' not found in ${filename}. No changes made.`;
      }

      const updatedContent = replace_all
        ? content.split(old_str).join(new_str)
        : content.replace(old_str, new_str);

      await fs.writeFile(resolvedPath, updatedContent, "utf8");

      emitWriter(toolConfig, {
        edit_file: "edit_file",
        file_path: filename,
        content: new_str,
      });

      return `Successfully updated ${filename}.`;
    } catch (error: any) {
      return `Error editing file: ${error.message}`;
    }
  },
  {
    name: "edit_file",
    description:
      "Find and replace text in a file. Use replace_all=true to replace every occurrence.",
    schema: z.object({
      filename: z.string().describe("File path relative to project root"),
      old_str: z.string().describe("Exact text to find"),
      new_str: z.string().describe("Replacement text"),
      replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace all occurrences instead of only the first"),
    }),
  }
);

async function buildTree(dirPath: string, prefix = "") {
  let output = "";
  let entries;

  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return output;
  }

  const visible = entries.filter(
    (entry) => !IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")
  );
  const dirs = visible.filter((entry) => entry.isDirectory());
  const files = visible.filter((entry) => !entry.isDirectory());
  const sorted = [...dirs, ...files];

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const isLast = i === sorted.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const child = isLast ? "    " : "│   ";
    const label = entry.isDirectory() ? `${entry.name}/` : entry.name;

    output += `${prefix}${branch}${label}\n`;

    if (entry.isDirectory()) {
      output += await buildTree(path.join(dirPath, entry.name), prefix + child);
    }
  }

  return output;
}

export const fileTreeTool = tool(
  async ({ directory }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const targetDir = directory
        ? resolveFilePath(userId, projectId, directory)
        : getProjectRoot(userId, projectId);
      const label = directory || ".";
      const tree = await buildTree(targetDir);

      return `📁 ${label}/\n${tree || "(empty)"}`;
    } catch (error: any) {
      return `Error building file tree: ${error.message}`;
    }
  },
  {
    name: "file_tree",
    description:
      "Get a recursive file tree of the project. Excludes node_modules, .git, dist, build, etc.",
    schema: z.object({
      directory: z
        .string()
        .optional()
        .describe("Subdirectory relative to project root. Empty means full project."),
    }),
  }
);

export const listDirTool = tool(
  async ({ directory }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const fullPath = directory
        ? resolveFilePath(userId, projectId, directory)
        : getProjectRoot(userId, projectId);

      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const lines = entries.map((entry) => {
        const type = entry.isDirectory() ? "[dir ]" : "[file]";
        return `${type} ${entry.name}`;
      });

      return `Contents of ${directory || "."}:\n${lines.join("\n")}`;
    } catch (error: any) {
      return `Error listing directory: ${error.message}`;
    }
  },
  {
    name: "list_dir",
    description: "List immediate contents of a directory.",
    schema: z.object({
      directory: z
        .string()
        .optional()
        .describe("Directory relative to project root. Empty means project root."),
    }),
  }
);

export const lsTool = tool(
  async ({ directory, pattern }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const base = directory
        ? resolveFilePath(userId, projectId, directory)
        : getProjectRoot(userId, projectId);

      const files = await glob(pattern || "**/*", {
        cwd: base,
        ignore: GLOB_IGNORE,
        nodir: true,
      });

      if (files.length === 0) {
        return `No files matched pattern "${pattern || "**/*"}"`;
      }

      return `${files.length} files in ${directory || "."}:\n${files.join("\n")}`;
    } catch (error: any) {
      return `Error running ls: ${error.message}`;
    }
  },
  {
    name: "ls",
    description: "List files matching a glob pattern inside the project sandbox.",
    schema: z.object({
      directory: z.string().optional().describe("Base directory relative to project root"),
      pattern: z
        .string()
        .optional()
        .describe("Glob pattern, e.g. '**/*.ts' or 'src/**/*.js'"),
    }),
  }
);

export const searchFileTool = tool(
  async ({ query, file_pattern, case_sensitive }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const projectRoot = getProjectRoot(userId, projectId);

      const files = await glob(file_pattern || "**/*.{js,ts,jsx,tsx,json,md}", {
        cwd: projectRoot,
        ignore: GLOB_IGNORE,
        nodir: true,
      });

      const flags = case_sensitive ? "g" : "gi";
      const regex = new RegExp(query, flags);
      const results: string[] = [];

      for (const file of files) {
        const fullPath = path.join(projectRoot, file);

        let content: string;
        try {
          content = await readTextFile(fullPath);
        } catch {
          continue;
        }

        const lines = content.split("\n");
        const matches: string[] = [];

        lines.forEach((line, index) => {
          regex.lastIndex = 0;
          if (regex.test(line)) {
            matches.push(`  ${index + 1}: ${line.trim()}`);
          }
        });

        if (matches.length > 0) {
          results.push(
            `📄 ${file} (${matches.length} match${matches.length > 1 ? "es" : ""}):\n${matches.join("\n")}`
          );
        }
      }

      if (results.length === 0) {
        return `No matches found for "${query}"`;
      }

      return `🔍 "${query}" — ${results.length} file(s):\n\n${results.join("\n\n")}`;
    } catch (error: any) {
      return `Error searching files: ${error.message}`;
    }
  },
  {
    name: "search_file",
    description:
      "Search for a string or regex across project files. Returns matching lines with line numbers.",
    schema: z.object({
      query: z.string().describe("String or regex pattern to search for"),
      file_pattern: z
        .string()
        .optional()
        .describe("Glob to limit files, e.g. '**/*.ts'"),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("Case-sensitive match (default: false)"),
    }),
  }
);

export const filesystemTools = [
  write_file,
  read_file,
  edit_file,
  fileTreeTool,
  listDirTool,
  lsTool,
  searchFileTool,
];

export const selectFileSystemTool = {
  read_file,
  write_file,
  edit_file,
  file_tree: fileTreeTool,
  list_dir: listDirTool,
  ls: lsTool,
  search_file: searchFileTool,
} as Record<string, any>;
