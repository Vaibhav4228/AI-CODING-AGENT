import path from "node:path";
import { config } from "dotenv";

// Both src/config and dist/config are three levels below the repository root.
config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
