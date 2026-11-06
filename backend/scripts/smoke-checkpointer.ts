import "../src/config/environment";
import { generateId } from "../src/helper/generateId";
import {
  ensureCheckpointerReady,
  checkpointer,
} from "../src/app/database/checkpointer";

async function main() {
  console.log("generateId:", generateId("thread"));

  await ensureCheckpointerReady();
  console.log("checkpointer:", checkpointer.constructor?.name ?? "ok");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
