// tsconfig paths inform the compiler but are not rewritten in emitted JS.
// Reuse the existing runtime loader instead of adding a build transformer.
const path = require("node:path");
const { register } = require("tsconfig-paths");

register({
  baseUrl: path.resolve(__dirname, "../dist"),
  paths: { "@/*": ["*"] },
});
