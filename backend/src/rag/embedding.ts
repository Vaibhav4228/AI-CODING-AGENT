import { CohereEmbeddings } from "@langchain/cohere";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { Document } from "@langchain/core/documents";
import { chunkFileByAST } from "./chunker";

export type EmbedFileInput = {
  path: string;
  content: string;
};

export type EmbedFilesResult = {
  fileChunkMap: Record<string, number>;
  parentCount: number;
  childCount: number;
  total: number;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing env ${name}. Add it to .env — see learning/08-embedding.md for API keys.`
    );
  }
  return value;
}

function getEmbeddings() {
  return new CohereEmbeddings({
    model: process.env.COHERE_EMBED_MODEL || "embed-english-v3.0",
    apiKey: requireEnv("COHERE_API_KEY"),
  });
}

async function getPineconeStore(embeddings: CohereEmbeddings) {
  const pinecone = new PineconeClient({
    apiKey: requireEnv("PINECONE_API_KEY"),
  });
  const index = pinecone.Index(requireEnv("PINECONE_INDEX"));
  return new PineconeStore(embeddings, {
    pineconeIndex: index,
    maxConcurrency: 5,
  });
}

function createChildrenFromParent(parentDoc: Document, parentId: string) {
  const lines = parentDoc.pageContent.split("\n");
  const mid = Math.ceil(lines.length / 2);
  const halves = [
    lines.slice(0, mid).join("\n"),
    lines.slice(mid).join("\n"),
  ].filter((half) => half.trim().length > 0);

  return halves.map((half, i) =>
    new Document({
      pageContent: half,
      metadata: {
        ...parentDoc.metadata,
        docType: "child",
        parentId,
        chunkId: `child-${parentId}-${i}`,
        source: `child-${parentId}-${i}`,
        chunkIndex: i,
      },
    })
  );
}

/**
 * AST-chunk files → parent + child docs → Cohere embed → Pinecone upsert.
 */
export async function embedFilesWithAST({
  files,
  userId,
  projectId,
}: {
  files: EmbedFileInput[];
  userId: string;
  projectId: string;
}): Promise<EmbedFilesResult> {
  if (!userId || !projectId) {
    throw new Error("userId and projectId are required for embedding.");
  }

  const embeddings = getEmbeddings();
  const vectorStore = await getPineconeStore(embeddings);

  const parentDocs: Document[] = [];
  const childDocs: Document[] = [];
  const fileChunkMap: Record<string, number> = {};

  for (const { path: filePath, content } of files) {
    const ext = path.extname(filePath).toLowerCase();
    const chunks = chunkFileByAST(content, filePath, ext);
    let childCountForFile = 0;

    for (const chunk of chunks) {
      const parentId = uuidv4();
      const parentDoc = new Document({
        pageContent: chunk.pageContent,
        metadata: {
          ...chunk.metadata,
          docType: "parent",
          chunkId: parentId,
          parentId,
          source: parentId,
          userId,
          projectId,
        },
      });
      parentDocs.push(parentDoc);

      if (chunk.pageContent.length > 600) {
        const children = createChildrenFromParent(parentDoc, parentId).map(
          (child) =>
            new Document({
              pageContent: child.pageContent,
              metadata: {
                ...child.metadata,
                userId,
                projectId,
              },
            })
        );
        childDocs.push(...children);
        childCountForFile += children.length;
      }
    }

    fileChunkMap[filePath] = chunks.length;
    console.log(
      `[RAG] ${filePath} → ${chunks.length} AST chunks, ${childCountForFile} children`
    );
  }

  console.log(
    `[RAG] Upserting ${parentDocs.length} parents + ${childDocs.length} children...`
  );
  await vectorStore.addDocuments([...parentDocs, ...childDocs]);
  console.log("[RAG] Done");

  return {
    fileChunkMap,
    parentCount: parentDocs.length,
    childCount: childDocs.length,
    total: parentDocs.length + childDocs.length,
  };
}
