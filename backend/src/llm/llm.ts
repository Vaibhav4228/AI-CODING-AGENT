import { ChatFireworks } from "@langchain/community/chat_models/fireworks";
import { ChatCerebras } from "@langchain/cerebras";
import "dotenv/config";

export type LLMType =
  | "fireworks"
  | "fireworks_minimax"
  | "fireworks_glm"
  | "cerebras_glm";

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120_000);

export class LLM {
  private static instances: Partial<Record<LLMType, any>> = {};

  private constructor() {}

  public static getInstance(type: LLMType = "fireworks") {
    if (!LLM.instances[type]) {
      switch (type) {
        case "fireworks": {
          if (!process.env.FIRE_WORKS_API_KEY) {
            throw new Error("FIRE_WORKS_API_KEY is not set");
          }
          LLM.instances[type] = new ChatFireworks({
            model:
              process.env.LLM_MODEL_POWERFUL ||
              "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking",
            temperature: 0.7,
            apiKey: process.env.FIRE_WORKS_API_KEY,
            timeout: DEFAULT_TIMEOUT_MS,
          });
          break;
        }

        case "fireworks_minimax": {
          if (!process.env.FIRE_WORKS_API_KEY) {
            throw new Error("FIRE_WORKS_API_KEY is not set");
          }
          LLM.instances[type] = new ChatFireworks({
            model:
              process.env.LLM_MODEL_FAST ||
              "accounts/fireworks/models/minimax-m2p5",
            temperature: 0.7,
            apiKey: process.env.FIRE_WORKS_API_KEY,
            timeout: DEFAULT_TIMEOUT_MS,
          });
          break;
        }

        case "fireworks_glm": {
          if (!process.env.FIRE_WORKS_API_KEY) {
            throw new Error("FIRE_WORKS_API_KEY is not set");
          }
          LLM.instances[type] = new ChatFireworks({
            model:
              process.env.LLM_MODEL_GLM ||
              "accounts/fireworks/models/glm-5p1",
            temperature: 0.7,
            apiKey: process.env.FIRE_WORKS_API_KEY,
            timeout: DEFAULT_TIMEOUT_MS,
          });
          break;
        }

        case "cerebras_glm": {
          if (!process.env.CEREBRAS_API_KEY) {
            throw new Error("CEREBRAS_API_KEY is not set");
          }
          LLM.instances[type] = new ChatCerebras({
            model: process.env.CEREBRAS_MODEL || "zai-glm-4.7",
            temperature: 0.7,
            apiKey: process.env.CEREBRAS_API_KEY,
          });
          break;
        }

        default:
          throw new Error(`Unsupported LLM type: ${type}`);
      }
    }

    return LLM.instances[type];
  }

  public static fromRoute(choice: "fast" | "powerful" = "powerful") {
    if (choice === "fast") {
      return LLM.getInstance("fireworks_minimax");
    }
    return LLM.getInstance("fireworks_glm");
  }
}
