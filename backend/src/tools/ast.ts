import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { parse } from "@babel/parser";
import fs from "fs/promises";
import path from "path";
import { resolveProjectPath } from "./shared/workingDir";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

function getContext(toolConfig: any) {
  const projectId = toolConfig.configurable?.projectId;
  const userId = toolConfig.configurable?.userId;

  if (!userId || !projectId) {
    throw new Error("Missing userId or projectId in tool configuration.");
  }

  return { userId, projectId };
}

function extractStructure(ast: any) {
  const result: any = {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    types: [],
    variables: [],
  };

  const visited = new WeakSet<object>();

  function visit(node: any, isExported = false) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    switch (node.type) {
      case "ImportDeclaration": {
        const specifiers = node.specifiers.map((specifier: any) => {
          if (specifier.type === "ImportDefaultSpecifier") {
            return `default → ${specifier.local.name}`;
          }
          if (specifier.type === "ImportNamespaceSpecifier") {
            return `* → ${specifier.local.name}`;
          }
          const imported = specifier.imported?.name ?? specifier.local.name;
          return imported === specifier.local.name
            ? imported
            : `${imported} → ${specifier.local.name}`;
        });
        result.imports.push({ from: node.source.value, specifiers });
        break;
      }

      case "ExportDefaultDeclaration": {
        if (node.declaration) visit(node.declaration, true);
        result.exports.push("default");
        break;
      }

      case "ExportNamedDeclaration": {
        if (node.declaration) visit(node.declaration, true);
        for (const spec of node.specifiers ?? []) {
          result.exports.push(spec.exported?.name ?? "?");
        }
        break;
      }

      case "ExportAllDeclaration": {
        result.exports.push(`* from '${node.source?.value}'`);
        break;
      }

      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const name = node.id?.name ?? (isExported ? "default" : "anonymous");
        result.functions.push({
          name,
          async: node.async ?? false,
          generator: node.generator ?? false,
          params: formatParams(node.params ?? []),
          returnType: node.returnType?.typeAnnotation?.type ?? null,
          line: node.loc?.start?.line ?? null,
          exported: isExported,
        });
        break;
      }

      case "ClassDeclaration":
      case "ClassExpression": {
        const methods = (node.body?.body ?? [])
          .filter(
            (member: any) =>
              member.type === "ClassMethod" ||
              member.type === "ClassProperty" ||
              member.type === "ClassAccessorProperty"
          )
          .map((member: any) => ({
            name: member.key?.name ?? member.key?.value ?? "?",
            kind: member.kind ?? "method",
            static: member.static ?? false,
            abstract: member.abstract ?? false,
            access: member.accessibility ?? "public",
          }));

        result.classes.push({
          name: node.id?.name ?? "anonymous",
          superClass: node.superClass?.name ?? null,
          methods,
          line: node.loc?.start?.line ?? null,
          exported: isExported,
        });
        break;
      }

      case "TSInterfaceDeclaration":
        result.types.push({
          kind: "interface",
          name: node.id?.name,
          line: node.loc?.start?.line,
        });
        break;

      case "TSTypeAliasDeclaration":
        result.types.push({
          kind: "type",
          name: node.id?.name,
          line: node.loc?.start?.line,
        });
        break;

      case "TSEnumDeclaration":
        result.types.push({
          kind: "enum",
          name: node.id?.name,
          members: (node.members ?? []).map(
            (member: any) => member.id?.name ?? member.id?.value ?? "?"
          ),
          line: node.loc?.start?.line,
        });
        break;

      case "VariableDeclaration": {
        for (const decl of node.declarations ?? []) {
          if (!decl.id?.name) continue;

          const initType = decl.init?.type;
          if (
            initType === "ArrowFunctionExpression" ||
            initType === "FunctionExpression"
          ) {
            visit({ ...decl.init, id: decl.id }, isExported);
          } else {
            result.variables.push({
              name: decl.id.name,
              kind: node.kind,
              line: node.loc?.start?.line ?? null,
              exported: isExported,
            });
          }
        }
        break;
      }

      case "Program": {
        for (const stmt of node.body ?? []) visit(stmt);
        break;
      }
    }
  }

  visit(ast.program);
  return result;
}

function formatParams(params: any[]) {
  return params.map((param: any) => {
    switch (param.type) {
      case "Identifier":
        return param.typeAnnotation
          ? `${param.name}: ${param.typeAnnotation.typeAnnotation?.type}`
          : param.name;
      case "AssignmentPattern":
        return `${param.left?.name ?? "?"} = ...`;
      case "RestElement":
        return `...${param.argument?.name ?? "?"}`;
      case "ObjectPattern":
        return "{...}";
      case "ArrayPattern":
        return "[...]";
      case "TSParameterProperty":
        return param.parameter?.name ?? "?";
      default:
        return "?";
    }
  });
}

function renderStructure(filePath: string, structure: any) {
  const lines = [`# AST — ${filePath}\n`];

  if (structure.imports.length > 0) {
    lines.push("## Imports");
    for (const imp of structure.imports) {
      lines.push(`  from '${imp.from}': ${imp.specifiers.join(", ")}`);
    }
  }

  if (structure.functions.length > 0) {
    lines.push("\n## Functions");
    for (const fn of structure.functions) {
      const flags = [
        fn.async ? "async" : null,
        fn.generator ? "generator" : null,
        fn.exported ? "export" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const ret = fn.returnType ? ` → ${fn.returnType}` : "";
      const meta = flags ? ` [${flags}]` : "";
      lines.push(
        `  ${fn.name}(${fn.params.join(", ")})${ret}${meta}  line ${fn.line}`
      );
    }
  }

  if (structure.classes.length > 0) {
    lines.push("\n## Classes");
    for (const cls of structure.classes) {
      const ext = cls.superClass ? ` extends ${cls.superClass}` : "";
      const exp = cls.exported ? " [export]" : "";
      lines.push(`  ${cls.name}${ext}${exp}  line ${cls.line}`);
      for (const method of cls.methods) {
        const flags = [
          method.static ? "static" : "",
          method.abstract ? "abstract" : "",
          method.access !== "public" ? method.access : "",
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(`      [${method.kind}] ${flags ? `${flags} ` : ""}${method.name}`);
      }
    }
  }

  if (structure.types.length > 0) {
    lines.push("\n## Types / Interfaces / Enums");
    for (const type of structure.types) {
      const members = type.members ? ` { ${type.members.join(", ")} }` : "";
      lines.push(`  [${type.kind}] ${type.name}${members}  line ${type.line}`);
    }
  }

  if (structure.variables.length > 0) {
    lines.push("\n## Top-level Variables");
    for (const variable of structure.variables) {
      const exp = variable.exported ? " [export]" : "";
      lines.push(`  ${variable.kind} ${variable.name}${exp}  line ${variable.line}`);
    }
  }

  if (structure.exports.length > 0) {
    lines.push("\n## Exports");
    lines.push(`  ${structure.exports.join(", ")}`);
  }

  return lines.join("\n");
}

export const astAnalyzeTool = tool(
  async ({ file_path }, toolConfig: any) => {
    try {
      const { userId, projectId } = getContext(toolConfig);
      const ext = path.extname(file_path).toLowerCase();

      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        return `Unsupported file type "${ext}". Use .js, .jsx, .ts, or .tsx files.`;
      }

      const fullPath = resolveProjectPath(userId, projectId, file_path);
      const content = await fs.readFile(fullPath, "utf-8");

      const isTS = [".ts", ".tsx"].includes(ext);
      const isJSX = [".jsx", ".tsx"].includes(ext);

      const plugins: any[] = [
        ...(isTS ? ["typescript"] : []),
        ...(isJSX ? ["jsx"] : []),
        "decorators-legacy",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "exportDefaultFrom",
        "importMeta",
        "topLevelAwait",
      ];

      const ast = parse(content, {
        sourceType: "module",
        plugins,
        errorRecovery: true,
        strictMode: false,
      });

      const structure = extractStructure(ast);
      return renderStructure(file_path, structure);
    } catch (error: any) {
      return `AST parse error for ${file_path}: ${error.message}`;
    }
  },
  {
    name: "ast_analyze",
    description:
      "Parse a JS/TS/JSX/TSX file with Babel and extract its full structure: " +
      "imports, exports, functions (with params, async, return type), classes (with methods), " +
      "TypeScript interfaces/types/enums, and top-level variables. " +
      "Use this instead of reading the full file when you want to understand what a file contains.",
    schema: z.object({
      file_path: z
        .string()
        .describe("Path to the JS/TS/JSX/TSX file relative to project root"),
    }),
  }
);

export const selectAstTools = {
  ast_analyze: astAnalyzeTool,
} as Record<string, any>;
