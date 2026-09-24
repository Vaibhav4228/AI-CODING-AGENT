import "dotenv/config";
import { generateId } from "../src/helper/generateId";
import {
  ensureCheckpointerReady,
  checkpointer,
} from "../src/app/bootstrap/checkpointer/mongodb-checkpointer";
import { LLM } from "../src/llm/llm";

async function main() {
  console.log("generateId:", generateId("thread"));

  await ensureCheckpointerReady();
  console.log("checkpointer:", checkpointer.constructor?.name ?? "ok");

  if (!process.env.FIRE_WORKS_API_KEY) {
    console.log("skip llm — set FIRE_WORKS_API_KEY when ready");
    return;
  }

  const llm = LLM.fromRoute("fast");
  console.log("llm:", llm?.constructor?.name ?? "ready");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
