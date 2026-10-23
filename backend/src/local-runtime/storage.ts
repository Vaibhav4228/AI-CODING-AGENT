import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { checkpointSchema, checkpointStateSchema, Checkpoint, CheckpointState, idSchema } from "@local-agent/protocol";

export class RevisionConflict extends Error {}

/** Caller-owned private extension storage only; never a model-selected path. */
export class LocalCheckpointStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error("Storage requires absolute private directory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("Invalid storage directory");
    const canonical = realpathSync(directory);
    const filename = path.join(canonical, "checkpoints.sqlite");
    for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
      try {
        const info = lstatSync(candidate);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error("Unsafe storage entry");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.db = new DatabaseSync(filename, { allowExtension: false });
    try {
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported checkpoint database version");
      if (process.platform !== "win32") {
        chmodSync(canonical, 0o700);
        chmodSync(filename, 0o600);
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS checkpoints (
          owner TEXT NOT NULL, workspace TEXT NOT NULL, run TEXT NOT NULL,
          revision INTEGER NOT NULL, state TEXT NOT NULL,
          PRIMARY KEY (owner, workspace, run)
        ) STRICT; PRAGMA user_version=1;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  load(owner: string, workspace: string, run: string): Checkpoint | null {
    [owner, workspace, run].forEach((value) => idSchema.parse(value));
    const row = this.db.prepare("SELECT revision, state FROM checkpoints WHERE owner=? AND workspace=? AND run=?").get(owner, workspace, run);
    if (!row) return null;
    return checkpointSchema.parse({ runId: run, revision: row.revision, state: JSON.parse(String(row.state)) });
  }

  save(owner: string, workspace: string, run: string, expectedRevision: number, state: CheckpointState): Checkpoint {
    const parsed = checkpointStateSchema.parse(state);
    [owner, workspace, run].forEach((value) => idSchema.parse(value));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid revision");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.load(owner, workspace, run);
      if ((current?.revision ?? 0) !== expectedRevision) throw new RevisionConflict();
      const next = checkpointSchema.parse({ runId: run, revision: expectedRevision + 1, state: parsed });
      this.db.prepare(`INSERT INTO checkpoints (owner, workspace, run, revision, state) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (owner, workspace, run) DO UPDATE SET revision=excluded.revision, state=excluded.state`)
        .run(owner, workspace, run, next.revision, JSON.stringify(next.state));
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
