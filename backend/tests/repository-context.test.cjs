const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chunkFileByAST } = require("../dist/rag/chunker.js");
const { getProjectRoot, resolveProjectPath } = require("../dist/tools/shared/workingDir.js");

test("built runtime resolves project aliases into dist rather than source", () => {
  require("../scripts/register-dist.cjs");
  assert.equal(require.resolve("@/tools/shared/workingDir"), require.resolve("../dist/tools/shared/workingDir.js"));
});

test("AST context preserves exported function bodies and source line provenance", () => {
  const content = "// pricing fixture\nexport function total(price: number, qty: number) {\n  return price * qty;\n}\n";
  const chunks = chunkFileByAST(content, "src/pricing.ts", ".ts");
  const match = chunks.find((chunk) => chunk.pageContent.includes("function total"));
  assert.ok(match);
  assert.match(match.pageContent, /return price \* qty;/);
  assert.equal(match.metadata.filePath, "src/pricing.ts");
  assert.equal(match.metadata.startLine, 2);
  assert.equal(match.metadata.chunkType, "ast");
});

test("TSX context handles JSX without losing the component body", () => {
  const content = 'export function Greeting() { return <h1>Hello</h1>; }';
  const chunks = chunkFileByAST(content, "src/Greeting.tsx", ".tsx");
  assert.ok(chunks.some((chunk) => chunk.pageContent.includes("<h1>Hello</h1>")));
  assert.ok(chunks.every((chunk) => chunk.metadata.chunkType === "ast"));
});

test("non-JS context uses text fallback and preserves source text", () => {
  const content = "def total(price, qty):\n    return price * qty\n";
  const chunks = chunkFileByAST(content, "pricing.py", ".py");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pageContent, content);
  assert.equal(chunks[0].metadata.chunkType, "character");
});

test("incomplete editor source can still be retrieved using fallback", () => {
  const content = "export function unfinished(";
  const chunks = chunkFileByAST(content, "draft.ts", ".ts");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pageContent, content);
  assert.equal(chunks[0].metadata.chunkType, "character");
});

// These are lexical containment checks only: not evidence of OS isolation,
// canonical link safety, ID ownership or resistance to filesystem races.
test("legacy path helper resolves nested paths in the selected project", () => {
  const root = getProjectRoot("fixture-user", "fixture-project");
  assert.equal(resolveProjectPath("fixture-user", "fixture-project", "src/app.ts"), path.join(root, "src/app.ts"));
});

test("legacy path helper rejects relative escape and a prefix-sharing sibling", () => {
  assert.throws(() => resolveProjectPath("fixture-user", "fixture-project", "../outside.txt"), /Path traversal blocked/);
  assert.throws(() => resolveProjectPath("fixture-user", "fixture-project", "../project-fixture-user-fixture-project-other/file.txt"), /Path traversal blocked/);
});

test("legacy path helper rejects absolute targets outside the selected project", () => {
  const outside = path.resolve(getProjectRoot("fixture-user", "fixture-project"), "..", "outside.txt");
  assert.throws(() => resolveProjectPath("fixture-user", "fixture-project", outside), /Path traversal blocked/);
});
