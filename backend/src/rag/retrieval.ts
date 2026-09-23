import { CohereEmbeddings } from "@langchain/cohere";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { Document } from "@langchain/core/documents";

/**
 * Multi-vector retrieval pipeline
 *
 * Flow:
 * 1. Similarity search on child chunks (small = precise semantic match)
 * 2. Collect unique parentIds from matched children
 * 3. Fetch the full parent chunks (large = rich context for the LLM)
 *
 * Fallback: if no children exist/match (short AST chunks never spawned children),
 * search parent docs directly.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing env ${name}. Add it to .env — see learning/08-embedding.md.`
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

async function getVectorStore(embeddings: CohereEmbeddings) {
  const pinecone = new PineconeClient({
    apiKey: requireEnv("PINECONE_API_KEY"),
  });
  const index = pinecone.Index(requireEnv("PINECONE_INDEX"));

  return PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex: index,
    maxConcurrency: 5,
  });
}

export type QueryMultiVectorResult = {
  query: string;
  retrievedDocs: Document[];
  childMatches: number;
};

/**
 * Query the vector store with semantic search using parent-child retrieval.
 */
export async function queryMultiVector({
  userId,
  projectId,
  query,
  kChildren = 6,
  kParents = 3,
}: {
  userId: string;
  projectId?: string;
  query: string;
  kChildren?: number;
  kParents?: number;
}): Promise<QueryMultiVectorResult> {
  if (!userId) {
    throw new Error("userId is required for retrieval.");
  }
  if (!query?.trim()) {
    throw new Error("query is required for retrieval.");
  }

  const embeddings = getEmbeddings();
  const vectorStore = await getVectorStore(embeddings);

  const tenantFilter = {
    userId,
    ...(projectId ? { projectId } : {}),
  };

  // Step 1: Find semantically similar child chunks
  const childDocs = await vectorStore.similaritySearch(query, kChildren, {
    docType: "child",
    ...tenantFilter,
  });
  console.log(`[RAG] Found ${childDocs.length} child matches`);

  // Fallback: short parents may have no children — search parents directly
  if (childDocs.length === 0) {
    const parentDocs = await vectorStore.similaritySearch(query, kParents, {
      docType: "parent",
      ...tenantFilter,
    });
    console.log(
      `[RAG] No children — fell back to ${parentDocs.length} parent docs`
    );
    return {
      query,
      retrievedDocs: parentDocs,
      childMatches: 0,
    };
  }

  // Step 2: Collect unique parent IDs from matched children
  const parentIds = [
    ...new Set(
      childDocs
        .map((doc) => doc.metadata.parentId as string | undefined)
        .filter((id): id is string => id != null)
    ),
  ];

  console.log(`[RAG] Fetching parents for ${parentIds.length} parentId(s)`);

  // Step 3: Retrieve full parent chunks (filtered + ranked by query)
  const retriever = vectorStore.asRetriever({
    k: kParents,
    filter: {
      docType: "parent",
      source: { $in: parentIds },
      ...tenantFilter,
    },
  });

  const retrievedDocs = await retriever.invoke(query);
  console.log(`[RAG] Retrieved ${retrievedDocs.length} parent documents`);

  return {
    query,
    retrievedDocs,
    childMatches: childDocs.length,
  };
}
