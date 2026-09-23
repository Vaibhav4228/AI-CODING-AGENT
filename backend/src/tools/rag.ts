import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { glob } from "glob";
import fs from "fs/promises";
import path from "path";
import { getProjectRoot, getUserProjectDir } from "./shared/workingDir";
import { embedFilesWithAST } from "@/rag/embedding";
import { recordEmbeddings } from "./ProjectContextBuilder";
import { queryMultiVector } from "@/rag/retrieval";

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

  return { userId, projectId };
}

export const embedCodebaseTool = tool(
  async ({ file_pattern }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const baseDir = getProjectRoot(userId, projectId);
      const projectDir = getUserProjectDir(userId, projectId);

      const pattern = file_pattern ?? "**/*.{js,ts,jsx,tsx}";
      const allFiles = await glob(pattern, {
        cwd: baseDir,
        ignore: GLOB_IGNORE,
        nodir: true,
        absolute: false,
      });

      if (!allFiles.length) {
        return `No files matched "${pattern}"`;
      }

      const files: { path: string; content: string }[] = [];
      const skipped: string[] = [];

      for (const filePath of allFiles) {
        try {
          const content = await fs.readFile(
            path.join(baseDir, filePath),
            "utf-8"
          );
          if (!content.trim()) {
            skipped.push(`${filePath} (empty)`);
            continue;
          }
          if (content.length > 500_000) {
            skipped.push(`${filePath} (too large)`);
            continue;
          }
          files.push({ path: filePath.replace(/\\/g, "/"), content });
        } catch (error: any) {
          skipped.push(`${filePath} (${error.message})`);
        }
      }

      if (!files.length) {
        return "No readable files to embed.";
      }

      const result = await embedFilesWithAST({ files, userId, projectId });
      await recordEmbeddings(result.fileChunkMap, projectDir);

      return (
        `Embedded ${files.length} files (AST-aware)\n` +
        `   ${result.parentCount} AST chunks + ${result.childCount} sub-chunks = ${result.total} total\n` +
        (skipped.length ? `   Skipped: ${skipped.join(", ")}` : "")
      );
    } catch (error: any) {
      return `Embedding error: ${error.message}`;
    }
  },
  {
    name: "embed_codebase",
    description:
      "Embed codebase files using AST-aware chunking — each chunk is a complete function, class, or type. " +
      "Check read_embeddings_index first to avoid re-embedding.",
    schema: z.object({
      file_pattern: z
        .string()
        .optional()
        .describe("Glob pattern (default: all JS/TS)"),
    }),
  }
);

export const queryCodebaseTool = tool(
  async ({ query, k_parents, k_children }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);

      const { retrievedDocs, childMatches } = await queryMultiVector({
        userId,
        projectId,
        query,
        kChildren: k_children ?? 6,
        kParents: k_parents ?? 3,
      });

      if (!retrievedDocs.length) {
        return `No results for "${query}" (${childMatches} sub-matches). Run embed_codebase first?`;
      }

      const results = retrievedDocs.map((doc, i) => {
        const meta = doc.metadata as Record<string, any>;
        const file = meta.filePath ?? meta.source ?? "unknown";
        const label = meta.chunkLabel ? ` [${meta.chunkLabel}]` : "";
        const line = meta.startLine ? ` line ${meta.startLine}` : "";
        const ext = path.extname(String(file)).replace(".", "") || "js";
        const body =
          doc.pageContent.length > 1200
            ? `${doc.pageContent.slice(0, 1200)}\n// ...(truncated)`
            : doc.pageContent;

        return `### ${i + 1}. ${file}${label}${line}\n\`\`\`${ext}\n${body}\n\`\`\``;
      });

      return `"${query}" — ${childMatches} child matches → ${retrievedDocs.length} AST chunks:\n\n${results.join("\n\n")}`;
    } catch (error: any) {
      return `Query error: ${error.message}`;
    }
  },
  {
    name: "query_codebase",
    description:
      "Semantic search over embedded code. Returns complete AST chunks (full functions/classes). " +
      "Requires embed_codebase to have run first. Uses userId/projectId from tool config.",
    schema: z.object({
      query: z.string().describe("Natural language or code query"),
      k_parents: z
        .number()
        .optional()
        .describe("Parent chunks to retrieve (default 3)"),
      k_children: z
        .number()
        .optional()
        .describe("Sub-chunks to search (default 6)"),
    }),
  }
);

export const ragTools = [embedCodebaseTool, queryCodebaseTool];

export const selectedRagTools = {
  embed_codebase: embedCodebaseTool,
  query_codebase: queryCodebaseTool,
} as Record<string, any>;
