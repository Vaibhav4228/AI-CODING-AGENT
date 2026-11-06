import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("artifacts", { recursive: true });
await build({ entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"], minify: true });
await build({ entryPoints: ["webview-ui/src/main.tsx"], outfile: "media/index.js", bundle: true, platform: "browser", format: "iife", target: "chrome120", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
await build({ entryPoints: ["src/demo.ts", "src/html.ts", "src/deepseek.ts"], outdir: "dist/test", bundle: true, platform: "node", format: "cjs", outExtension: { ".js": ".cjs" } });
await build({ entryPoints: ["tests/host-suite.cjs"], outfile: "dist/host-suite.cjs", bundle: true, platform: "node", format: "cjs", external: ["vscode"] });
console.log("Built extension host, bundled webview, and test harnesses.");
