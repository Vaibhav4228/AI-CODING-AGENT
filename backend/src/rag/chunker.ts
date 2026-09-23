import { parse } from "@babel/parser";
import { Document } from "@langchain/core/documents";

/**
 * AST-aware chunker for JS/TS files.
 *
 * PROBLEM with naive character-count chunking:
 *   - A 2000-char chunk might split a function in half
 *   - The LLM gets incomplete, meaningless code
 *   - Semantic search retrieves broken snippets
 *
 * SOLUTION — chunk at AST boundaries:
 *   Each chunk = one complete, meaningful unit:
 *     - function declaration / arrow function assigned to const
 *     - class declaration (with all its methods)
 *     - TypeScript interface / type alias / enum
 *     - export group
 *     - top-level const/let/var
 *     - import block (grouped together)
 *
 * If a single unit is still too large (e.g. a 500-line class),
 * we fall back to splitting it by its methods.
 *
 * Non-JS/TS files fall back to character-based chunking.
 */

const MAX_CHUNK_CHARS = 3000;
const JS_TS_EXTS = new Set([".js", ".ts", ".jsx", ".tsx"]);

function babelParse(content: string, ext: string) {
  const isTS = [".ts", ".tsx"].includes(ext);
  const isJSX = [".jsx", ".tsx"].includes(ext);

  return parse(content, {
    sourceType: "module",
    errorRecovery: true,
    plugins: [
      ...(isTS ? ["typescript"] : []),
      ...(isJSX ? ["jsx"] : []),
      "decorators-legacy",
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "importMeta",
      "topLevelAwait",
    ] as any,
  });
}

function nodeSource(content: string, node: any) {
  return content.slice(node.start, node.end);
}

function nodeLabel(node: any) {
  switch (node.type) {
    case "FunctionDeclaration":
      return `function ${node.id?.name ?? "anonymous"}`;
    case "ClassDeclaration":
      return `class ${node.id?.name ?? "anonymous"}`;
    case "TSInterfaceDeclaration":
      return `interface ${node.id?.name}`;
    case "TSTypeAliasDeclaration":
      return `type ${node.id?.name}`;
    case "TSEnumDeclaration":
      return `enum ${node.id?.name}`;
    case "ExportDefaultDeclaration":
      return "export default";
    case "ExportNamedDeclaration":
      return `export { ${(node.specifiers ?? [])
        .map((s: any) => s.exported?.name)
        .join(", ")} }`;
    case "ExportAllDeclaration":
      return `export * from '${node.source?.value}'`;
    case "VariableDeclaration": {
      const names = (node.declarations ?? [])
        .map((d: any) => d.id?.name ?? "?")
        .join(", ");
      return `${node.kind} ${names}`;
    }
    case "ImportDeclaration":
      return `import from '${node.source?.value}'`;
    default:
      return node.type;
  }
}

/**
 * Split a class node by its methods if the class is too large.
 */
function splitClassByMethods(content: string, classNode: any) {
  const className = classNode.id?.name ?? "anonymous";
  const methods = (classNode.body?.body ?? []).filter(
    (m: any) => m.type === "ClassMethod" || m.type === "ClassPrivateMethod"
  );

  if (!methods.length) {
    return [
      {
        label: `class ${className}`,
        source: nodeSource(content, classNode),
        line: classNode.loc?.start?.line,
      },
    ];
  }

  const chunks: { label: string; source: string; line: number }[] = [];
  const ctor = methods.find((m: any) => m.kind === "constructor");
  const header = ctor
    ? content.slice(classNode.start, ctor.end) + "\n}"
    : `class ${className} { /* see methods below */ }`;

  chunks.push({
    label: `class ${className} (header)`,
    source: header,
    line: classNode.loc?.start?.line,
  });

  for (const method of methods) {
    if (method.kind === "constructor") continue;
    const name = method.key?.name ?? method.key?.value ?? "?";
    chunks.push({
      label: `class ${className}.${name}`,
      source: nodeSource(content, method),
      line: method.loc?.start?.line,
    });
  }

  return chunks;
}

/**
 * Extract a variable declaration's inner function/arrow if it's assigned one.
 */
function unwrapVarDecl(node: any, content: string) {
  if (node.type !== "VariableDeclaration") return null;
  const decl = node.declarations?.[0];
  if (!decl) return null;

  const init = decl.init;
  if (
    init?.type === "ArrowFunctionExpression" ||
    init?.type === "FunctionExpression"
  ) {
    return {
      label: `const ${decl.id?.name ?? "?"}`,
      source: nodeSource(content, node),
      line: node.loc?.start?.line,
    };
  }
  return null;
}

/**
 * Fallback chunker for non-JS files or unparseable files.
 * Splits on blank lines into ~2000 char blocks.
 */
function chunkByCharacters(content: string, filePath: string) {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let charCount = 0;

  for (const line of lines) {
    current.push(line);
    charCount += line.length + 1;

    if (charCount >= 2000 && line.trim() === "") {
      chunks.push(current.join("\n"));
      current = [];
      charCount = 0;
    }
  }

  if (current.length) chunks.push(current.join("\n"));

  return chunks
    .filter((c) => c.trim().length > 0)
    .map(
      (chunk, i) =>
        new Document({
          pageContent: chunk,
          metadata: {
            filePath,
            chunkIndex: i,
            chunkType: "character",
            charCount: chunk.length,
          },
        })
    );
}

export function chunkFileByAST(content: string, filePath: string, ext: string) {
  if (!JS_TS_EXTS.has(ext)) {
    return chunkByCharacters(content, filePath);
  }

  let ast;
  try {
    ast = babelParse(content, ext);
  } catch {
    return chunkByCharacters(content, filePath);
  }

  const body: any[] = ast.program?.body ?? [];
  const rawChunks: { label: string; source: string; line: number }[] = [];
  let importBuf: any[] = [];

  for (const node of body) {
    if (node.type === "ImportDeclaration") {
      importBuf.push(node);
      continue;
    }

    if (importBuf.length) {
      rawChunks.push({
        label: "imports",
        source: importBuf.map((n) => nodeSource(content, n)).join("\n"),
        line: importBuf[0].loc?.start?.line ?? 1,
      });
      importBuf = [];
    }

    const src = nodeSource(content, node);

    if (
      (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
      src.length > MAX_CHUNK_CHARS
    ) {
      rawChunks.push(...splitClassByMethods(content, node));
      continue;
    }

    if (
      node.type === "ExportDefaultDeclaration" &&
      (node.declaration?.type === "ClassDeclaration" ||
        node.declaration?.type === "ClassExpression") &&
      src.length > MAX_CHUNK_CHARS
    ) {
      rawChunks.push(...splitClassByMethods(content, node.declaration));
      continue;
    }

    const unwrapped = unwrapVarDecl(node, content);
    if (unwrapped) {
      rawChunks.push(unwrapped);
      continue;
    }

    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const inner = node.declaration;
      const innerSrc = nodeSource(content, node);

      if (inner.type === "ClassDeclaration" && innerSrc.length > MAX_CHUNK_CHARS) {
        rawChunks.push(...splitClassByMethods(content, inner));
      } else {
        rawChunks.push({
          label: nodeLabel(node),
          source: innerSrc,
          line: node.loc?.start?.line ?? 1,
        });
      }
      continue;
    }

    rawChunks.push({
      label: nodeLabel(node),
      source: src,
      line: node.loc?.start?.line ?? 1,
    });
  }

  if (importBuf.length) {
    rawChunks.push({
      label: "imports",
      source: importBuf.map((n) => nodeSource(content, n)).join("\n"),
      line: importBuf[0].loc?.start?.line ?? 1,
    });
  }

  return rawChunks
    .filter((c) => c.source.trim().length > 0)
    .map(
      (chunk, i) =>
        new Document({
          pageContent: chunk.source,
          metadata: {
            filePath,
            chunkLabel: chunk.label,
            chunkIndex: i,
            startLine: chunk.line,
            chunkType: "ast",
            charCount: chunk.source.length,
          },
        })
    );
}
