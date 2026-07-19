import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getProjectRoot, getUserProjectDir } from "@/tools/shared/workingDir";

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, os.tmpdir());
  },
  filename: (_req, _file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `upload-${uniqueSuffix}.zip`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

const BLOCK_DIRS = new Set(["node_modules", ".git", "build", "dist", ".env"]);

function isSafePath(entryPath: string) {
  return !entryPath
    .split(/[\\/]/)
    .some((segment) => BLOCK_DIRS.has(segment) || segment === "..");
}

export function uploadProject(router: Router) {
  return router.post("/upload-zip", upload.single("project"), uploadZipFile);
}

const uploadZipFile = async (req: Request, res: Response, next: NextFunction) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;

  if (!file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  const { userId, projectId, clean } = req.body as Record<string, string>;

  console.log("Uploading project", { userId, projectId, clean });

  if (!userId || !projectId) {
    return res.status(400).json({ error: "userId and projectId are required." });
  }

  const targetDir = getProjectRoot(userId, projectId);
  const projectFolder = getUserProjectDir(userId, projectId);

  try {
    await fs.mkdir(targetDir, { recursive: true });

    if (clean === "true") {
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "README.md" || entry.name === ".agent") continue;
        await fs.rm(path.join(targetDir, entry.name), { recursive: true, force: true });
      }
    }

    const zip = new AdmZip(file.path);
    const written: string[] = [];
    const skipped: string[] = [];

    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;

      if (!isSafePath(entry.entryName)) {
        skipped.push(entry.entryName);
        continue;
      }

      const dest = path.join(targetDir, entry.entryName);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, entry.getData());
      written.push(entry.entryName);
    }

    res.json({
      message: `Extracted to ${projectFolder}`,
      target: `working-dir/${projectFolder}`,
      files: written,
      skipped,
      fileCount: written.length,
    });
  } catch (error) {
    next(error);
  } finally {
    if (file.path) {
      try {
        await fs.unlink(file.path);
      } catch (cleanupError) {
        console.error("Failed to delete temporary zip file:", cleanupError);
      }
    }
  }
};
