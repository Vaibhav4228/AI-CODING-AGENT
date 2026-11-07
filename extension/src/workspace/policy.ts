import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

export const MAX_FILE_BYTES = 256 * 1024;
export class ContextDenied extends Error {
  constructor(message = "That file is outside the selected workspace or is excluded.") { super(message); }
}
const blockedDirectories = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "coverage", ".cache", ".venv", "__pycache__", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker"]);
const blockedExtensions = /\.(pem|key|p12|pfx|jks|keystore|sqlite|db|png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|exe|dll|bin|woff2?|mp[34]|mov)$/i;
export function excludedByDefault(relative: string): boolean {
  const parts = relative.replace(/\\/g, "/").split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return parts.some((part) => blockedDirectories.has(part.toLowerCase())) ||
    name === ".env" || name.startsWith(".env.") || /^(?:credentials(?:\.\w+)?|secrets?(?:\.\w+)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc)$/.test(name) || blockedExtensions.test(name);
}
export function containsSensitiveText(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}|\bsk-[A-Za-z0-9_-]{20,}/i.test(text);
}

/** Read-only defense in depth, not an OS sandbox or a race-proof filesystem broker. */
export class WorkspaceGuard {
  readonly canonicalRoot: string;
  readonly root: string;
  constructor(root: string, private readonly readUnsavedRule?: (filename: string) => string | undefined) {
    if (!path.isAbsolute(root)) throw new ContextDenied();
    this.root = path.resolve(root);
    this.canonicalRoot = fs.realpathSync(this.root);
    if (!fs.statSync(this.canonicalRoot).isDirectory()) throw new ContextDenied();
  }
  check(filename: string, allowMissing = false): { relativePath: string; filename: string; size: number } {
    const relative = path.relative(this.root, path.resolve(filename));
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.includes("\0")) throw new ContextDenied();
    const parts = relative.split(path.sep);
    if (relative.length > 1024 || parts.length > 32 || parts.some((part) => part.includes(":")) || excludedByDefault(relative) || containsSensitiveText(relative)) throw new ContextDenied();
    let current = this.canonicalRoot;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, {throwIfNoEntry:false});
      if (!stat && allowMissing) break;
      if (!stat) throw new ContextDenied();
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new ContextDenied();
      if (index === parts.length - 1 && (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_FILE_BYTES)) throw new ContextDenied("File is excluded, unsupported, or larger than 256 KiB.");
    }
    const normalized = parts.join("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const directory = path.join(this.canonicalRoot, ...parts.slice(0, depth));
      const candidate = parts.slice(depth).join("/");
      for (const name of [".gitignore", ".agentignore"]) {
        const ruleFile = path.join(directory, name);
        let rules: string | undefined;
        try {
          const stat = fs.lstatSync(ruleFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 32768) throw new ContextDenied("Ignore rules could not be safely loaded.");
          rules = this.readUnsavedRule?.(path.join(this.root, ...parts.slice(0, depth), name)) ?? fs.readFileSync(ruleFile, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (rules !== undefined) {
          if (Buffer.byteLength(rules, "utf8") > 32768 || rules.split("\n").length > 1000) throw new ContextDenied("Ignore rules exceed the allowed limit.");
          try { if (ignore().add(rules).ignores(candidate)) throw new ContextDenied(); }
          catch (error) { if (error instanceof ContextDenied) throw error; throw new ContextDenied("Ignore rules could not be safely loaded."); }
        }
      }
    }
    return { relativePath: normalized, filename: path.resolve(filename), size: fs.statSync(filename,{throwIfNoEntry:false})?.size ?? 0 };
  }
}
