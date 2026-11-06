import { MongoClient } from "mongodb";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";

export const mongodbClient = new MongoClient(process.env.DB_URL as string);

export const checkpointer = new MongoDBSaver({
  client: mongodbClient,
} as any);

let connected = false;

export async function ensureCheckpointerReady() {
  if (connected) return;
  if (!process.env.DB_URL) {
    throw new Error("DB_URL is not set");
  }
  await mongodbClient.connect();
  connected = true;
}
