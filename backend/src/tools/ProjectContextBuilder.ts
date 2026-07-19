import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { WORKING_DIR, getUserProjectDir } from "./shared/workingDir";

/**
 * .agent/ directory structure
 *
 * .agent/
 *   index.md          ← always loaded: project overview, stack, entry points
 *   modules/
 *     auth.md         ← module-specific knowledge
 *     api.md
 *   graph.json        ← import graph (written later by import_graph tool)
 *   embeddings.json   ← RAG index tracking
 *
 * Agent loads index.md every session.
 * Agent loads module files only when the task touches that module.
 */

function getContext(toolConfig: any) {
  const projectId = toolConfig.configurable?.projectId;
  const userId = toolConfig.configurable?.userId;

  if (!userId || !projectId) {
    throw new Error("Missing userId or projectId in tool configuration.");
  }

  const projectDir = getUserProjectDir(userId, projectId);
  return { userId, projectId, projectDir };
}

function getAgentDir(projectDir: string) {
  return path.join(WORKING_DIR, projectDir, ".agent");
}

function getIndexPath(projectDir: string) {
  return path.join(getAgentDir(projectDir), "index.md");
}

function getModulesDir(projectDir: string) {
  return path.join(getAgentDir(projectDir), "modules");
}

function getEmbeddingsPath(projectDir: string) {
  return path.join(getAgentDir(projectDir), "embeddings.json");
}

function sanitizeModuleName(name: string) {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9_-]/g, "-");

  if (!cleaned || cleaned.includes("..")) {
    throw new Error(`Invalid module name: ${name}`);
  }

  return cleaned;
}

const INDEX_TEMPLATE = `# Agent Memory — Index
> Auto-maintained. Loaded every session. Keep this concise — details go in modules/.
> Last updated: ${new Date().toISOString()}

## Project Overview
*Not yet analyzed*

## Tech Stack
*Not yet detected*

## Entry Points
*Not yet identified*

## Module Map
> List each logical module and its .agent/modules/<name>.md file
*Not yet mapped*

## Key Conventions
*Not yet observed*

## Known Issues
*None recorded*
`;

async function ensureAgentDir(projectDir: string) {
  const modulesDir = getModulesDir(projectDir);
  const indexPath = getIndexPath(projectDir);

  await fs.mkdir(modulesDir, { recursive: true });

  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, INDEX_TEMPLATE, "utf-8");
    console.log("[AgentMemory] Created .agent/index.md");
  }
}

function escapeRegex(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeSectionReplace(
  content: string,
  section: string,
  newContent: string,
  append = false
) {
  const regex = new RegExp(
    `(## ${escapeRegex(section)}\\n)([\\s\\S]*?)(?=\\n## |$)`,
    "m"
  );
  const match = regex.exec(content);

  if (match) {
    if (append) {
      const existing = match[2].trim();
      const merged = existing ? `${existing}\n${newContent}` : newContent;
      return content.replace(regex, `## ${section}\n${merged}\n`);
    }
    return content.replace(regex, `## ${section}\n${newContent}\n`);
  }

  return `${content.trimEnd()}\n\n## ${section}\n${newContent}\n`;
}

function touchTimestamp(content: string) {
  return content.replace(
    /Last updated: .*/,
    `Last updated: ${new Date().toISOString()}`
  );
}

export const readAgentIndexTool = tool(
  async (_input, toolConfig: any) => {
    try {
      const { projectDir } = getContext(toolConfig);
      const indexPath = getIndexPath(projectDir);
      const modulesDir = getModulesDir(projectDir);

      await ensureAgentDir(projectDir);
      const content = await fs.readFile(indexPath, "utf-8");

      let moduleList = "";
      try {
        const files = await fs.readdir(modulesDir);
        const mds = files.filter((file) => file.endsWith(".md"));
        moduleList = mds.length
          ? `\n\n---\nAvailable module files (load with read_agent_module):\n${mds
              .map((file) => `  - ${file.replace(".md", "")}`)
              .join("\n")}`
          : "\n\n---\nNo module files yet.";
      } catch {
        moduleList = "\n\n---\nNo module files yet.";
      }

      return `.agent/index.md\n\n${content}${moduleList}`;
    } catch (error: any) {
      return `Error reading agent index: ${error.message}`;
    }
  },
  {
    name: "read_agent_index",
    description:
      "Read .agent/index.md — the agent's top-level project memory. " +
      "ALWAYS call this first at session start. " +
      "It contains project overview, tech stack, entry points, and the module map. " +
      "For module-specific details, use read_agent_module.",
    schema: z.object({}),
  }
);

export const updateAgentIndexTool = tool(
  async ({ section, content, append }, toolConfig: any) => {
    try {
      const { projectDir } = getContext(toolConfig);
      const indexPath = getIndexPath(projectDir);

      await ensureAgentDir(projectDir);
      let current = await fs.readFile(indexPath, "utf-8");
      current = safeSectionReplace(current, section, content, append ?? false);
      current = touchTimestamp(current);
      await fs.writeFile(indexPath, current, "utf-8");

      return `.agent/index.md → section "${section}" ${append ? "appended" : "updated"}`;
    } catch (error: any) {
      return `Error updating agent index: ${error.message}`;
    }
  },
  {
    name: "update_agent_index",
    description:
      "Update a section in .agent/index.md. Keep index.md high-level and concise. " +
      "Sections: 'Project Overview', 'Tech Stack', 'Entry Points', 'Module Map', 'Key Conventions', 'Known Issues'. " +
      "For module-specific details, use write_agent_module instead.",
    schema: z.object({
      section: z.string().describe("Section heading (without ##)"),
      content: z.string().describe("Markdown content for this section"),
      append: z.boolean().optional().describe("Append instead of replacing"),
    }),
  }
);

export const readAgentModuleTool = tool(
  async ({ module_name }, toolConfig: any) => {
    try {
      const { projectDir } = getContext(toolConfig);
      const modulesDir = getModulesDir(projectDir);
      const safeName = sanitizeModuleName(module_name);

      await ensureAgentDir(projectDir);

      const filePath = path.join(modulesDir, `${safeName}.md`);

      try {
        const content = await fs.readFile(filePath, "utf-8");
        return `.agent/modules/${safeName}.md\n\n${content}`;
      } catch {
        return `No module file for "${safeName}" yet. Use write_agent_module to create it.`;
      }
    } catch (error: any) {
      return `Error reading agent module: ${error.message}`;
    }
  },
  {
    name: "read_agent_module",
    description:
      "Read a module-specific memory file from .agent/modules/<name>.md. " +
      "Load this when your task touches a specific module (e.g. 'auth', 'api', 'ui', 'db'). " +
      "Check index.md Module Map section to see what modules exist.",
    schema: z.object({
      module_name: z
        .string()
        .describe("Module name without .md (e.g. 'auth', 'api', 'ui', 'database')"),
    }),
  }
);

export const writeAgentModuleTool = tool(
  async ({ module_name, section, content, append }, toolConfig: any) => {
    try {
      const { projectDir } = getContext(toolConfig);
      const modulesDir = getModulesDir(projectDir);
      const safeName = sanitizeModuleName(module_name);

      await ensureAgentDir(projectDir);

      const filePath = path.join(modulesDir, `${safeName}.md`);

      let current: string;
      try {
        current = await fs.readFile(filePath, "utf-8");
      } catch {
        current = `# Module: ${safeName}
> Auto-maintained by the coding agent.
> Last updated: ${new Date().toISOString()}

## Overview
*Not yet analyzed*

## Key Files
*Not yet identified*

## Exports & API Surface
*Not yet documented*

## Patterns & Conventions
*Not yet observed*

## Dependencies
*Not yet mapped*

## Known Issues
*None recorded*
`;
        console.log(`[AgentMemory] Created .agent/modules/${safeName}.md`);
      }

      current = safeSectionReplace(current, section, content, append ?? false);
      current = touchTimestamp(current);
      await fs.writeFile(filePath, current, "utf-8");

      return `.agent/modules/${safeName}.md → section "${section}" ${append ? "appended" : "updated"}`;
    } catch (error: any) {
      return `Error writing agent module: ${error.message}`;
    }
  },
  {
    name: "write_agent_module",
    description:
      "Write module-specific knowledge to .agent/modules/<name>.md. " +
      "Create one module file per logical domain of the project (auth, api, ui, database, etc.). " +
      "Sections: 'Overview', 'Key Files', 'Exports & API Surface', 'Patterns & Conventions', 'Dependencies', 'Known Issues'. " +
      "After creating a new module file, update index.md Module Map with update_agent_index.",
    schema: z.object({
      module_name: z
        .string()
        .describe("Module name (e.g. 'auth', 'api', 'ui', 'database')"),
      section: z.string().describe("Section heading (without ##)"),
      content: z.string().describe("Markdown content"),
      append: z.boolean().optional().describe("Append instead of replacing"),
    }),
  }
);

export const listAgentModulesTool = tool(
  async (_input, toolConfig: any) => {
    try {
      const { projectDir } = getContext(toolConfig);
      const modulesDir = getModulesDir(projectDir);

      await ensureAgentDir(projectDir);

      const files = await fs.readdir(modulesDir);
      const mds = files.filter((file) => file.endsWith(".md"));

      if (!mds.length) return "No module files yet in .agent/modules/";

      const previews = await Promise.all(
        mds.map(async (file) => {
          const content = await fs.readFile(path.join(modulesDir, file), "utf-8");
          const overview =
            content
              .match(/## Overview\n([\s\S]*?)(?=\n##|$)/)?.[1]
              ?.trim() ?? "no overview";
          return `  ${file.replace(".md", "")} — ${overview.slice(0, 100)}`;
        })
      );

      return `Available modules (${mds.length}):\n${previews.join("\n")}`;
    } catch (error: any) {
      return `Error listing agent modules: ${error.message}`;
    }
  },
  {
    name: "list_agent_modules",
    description:
      "List all module memory files in .agent/modules/ with a brief preview of each.",
    schema: z.object({}),
  }
);

export const readEmbeddingsIndexTool = tool(
  async (_input, toolConfig: any) => {
    try {
      const { projectDir } = getContext(toolConfig);
      const embeddingsPath = getEmbeddingsPath(projectDir);

      const raw = await fs.readFile(embeddingsPath, "utf-8");
      const data = JSON.parse(raw);
      const entries = Object.entries(data);

      if (!entries.length) return "No files have been embedded yet.";

      const lines = entries.map(([file, info]) => {
        const meta = info as { embeddedAt?: string; chunkCount?: number };
        return `  ${file} — embedded ${
          meta.embeddedAt
            ? new Date(meta.embeddedAt).toLocaleDateString()
            : "unknown"
        }, ${meta.chunkCount ?? 0} chunks`;
      });

      return `Embedded files (${entries.length}):\n${lines.join("\n")}`;
    } catch {
      return "No embeddings index yet. Run embed_codebase to start indexing.";
    }
  },
  {
    name: "read_embeddings_index",
    description:
      "Check which files have already been embedded into the RAG vector store. " +
      "Use this before embed_codebase to avoid re-embedding files unnecessarily.",
    schema: z.object({}),
  }
);

/** Used later by RAG tool to track indexed files */
export async function recordEmbeddings(
  fileChunkMap: Record<string, number>,
  projectDir: string
) {
  const embeddingsPath = getEmbeddingsPath(projectDir);
  await ensureAgentDir(projectDir);

  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(await fs.readFile(embeddingsPath, "utf-8"));
  } catch {
    // first time
  }

  const now = new Date().toISOString();
  for (const [file, chunkCount] of Object.entries(fileChunkMap)) {
    existing[file] = { embeddedAt: now, chunkCount };
  }

  await fs.writeFile(embeddingsPath, JSON.stringify(existing, null, 2), "utf-8");
}

export const agentMemoryTools = [
  readAgentIndexTool,
  updateAgentIndexTool,
  readAgentModuleTool,
  writeAgentModuleTool,
  listAgentModulesTool,
  readEmbeddingsIndexTool,
];

export const selectedAgentMemoryTools = {
  read_agent_index: readAgentIndexTool,
  update_agent_index: updateAgentIndexTool,
  read_agent_module: readAgentModuleTool,
  write_agent_module: writeAgentModuleTool,
  list_agent_modules: listAgentModulesTool,
  read_embeddings_index: readEmbeddingsIndexTool,
} as Record<string, any>;
