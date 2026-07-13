import path from "path";

export const WORKING_DIR = path.resolve(process.cwd(), "public/working-dir");

export function getUserProjectDir(userId: string, projectId: string): string {
  return `project-${userId}-${projectId}`;
}

export function getProjectRoot(userId: string, projectId: string): string {
  return path.resolve(WORKING_DIR, getUserProjectDir(userId, projectId));
}

/**
 * Resolve a path inside the project sandbox. Blocks traversal outside project root.
 */
export function resolveProjectPath(
  userId: string,
  projectId: string,
  relativePath = "."
): string {
  const projectRoot = getProjectRoot(userId, projectId);
  const resolved = path.resolve(projectRoot, relativePath);

  if (
    resolved !== projectRoot &&
    !resolved.startsWith(projectRoot + path.sep)
  ) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }

  return resolved;
}
