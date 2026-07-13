import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import {
  getProjectRoot,
  resolveProjectPath,
} from "./shared/workingDir";

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_SEC = 30;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 600;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

type Platform = "windows" | "macos" | "linux";

function getPlatform(): Platform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function getShellLabel(platform: Platform): string {
  switch (platform) {
    case "windows":
      return "PowerShell";
    case "macos":
      return "zsh";
    case "linux":
      return "bash";
  }
}

function spawnShell(command: string, cwd: string, env?: Record<string, string>) {
  const platform = getPlatform();
  const shellEnv = { ...process.env, ...env };

  if (platform === "windows") {
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { cwd, env: shellEnv, windowsHide: true }
    );
  }

  if (platform === "macos") {
    // macOS default shell since Catalina — loads login env (Homebrew, nvm, etc.)
    return spawn("/bin/zsh", ["-lc", command], { cwd, env: shellEnv });
  }

  return spawn("/bin/bash", ["-lc", command], { cwd, env: shellEnv });
}

const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\/(?!\w)/,
  /rm\s+-rf\s+~\//,
  />\s*\/dev\//,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\s*\{.*\}/,
  /sudo\s+rm/,
  /shutdown|reboot|halt|poweroff/,
  /curl\s+.*\|\s*(?:bash|sh|zsh|powershell|pwsh)/,
  /wget\s+.*\|\s*(?:bash|sh|zsh|powershell|pwsh)/,
  /\beval\b/,
  /Invoke-Expression/i,
  /iex\s+/i,
  /base64\s+.*\|\s*(?:bash|sh|powershell|pwsh)/,
  /(?:^|[;&|])\s*\/(?:etc|home|root|usr|var|sys|proc)\b/,
  /format\s+[a-z]:/i,
  /Remove-Item\s+.*-Recurse.*(?:\\|\/)?(?:Windows|Program Files|Users\\[^\\]+\\AppData)/i,
  /del\s+\/[sf]\s+[a-z]:\\/i,
  /reg\s+delete/i,
  /net\s+user\s+/i,
  /Set-ExecutionPolicy/i,
  /diskutil\s+(?:erase|zeroDisk|partitionDisk)/i,
  /sudo\s+(?:shutdown|reboot|halt|poweroff)/i,
  /launchctl\s+(?:unload|remove|bootout)\s+\/System/i,
];

const INTERACTIVE_PATTERNS: RegExp[] = [
  /\brd\s+\/s(?!\s+\/q)/i,
  /\bnpm\s+init\b(?!.*-y)/i,
  /\bnpx\s+create-[^\s]+\b(?!.*--yes|-y)/i,
  /\bapt(?:-get)?\s+install\b(?!.*-y)/i,
  /\byum\s+install\b(?!.*-y)/i,
  /\bgit\s+commit\b(?!.*-m)/i,
  /\b(?:nano|vim?|vi|emacs|less|more|top|htop)\b/i,
  /\bRead-Host\b/i,
  /\bssh\b/i,
  /\b(?:python3?|node)\s*$/i,
];

interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutSec: number;
  env?: Record<string, string>;
}

interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

function normalizeCommand(command: string): string {
  let normalized = command.trim();
  const platform = getPlatform();

  if (platform === "windows") {
    if (/^rd\s+\/s\s+/i.test(normalized) && !/\/q/i.test(normalized)) {
      normalized = normalized.replace(/rd\s+\/s/i, "rd /s /q");
    }
    if (/\bnpm\s+init\b(?!.*-y)/i.test(normalized) && !/-y/.test(normalized)) {
      normalized = `${normalized} -y`;
    }
    return normalized;
  }

  if (/\bnpm\s+init\b(?!.*-y)/.test(normalized)) {
    normalized = `${normalized} -y`;
  }

  if (platform === "linux" && /apt(?:-get)?\s+install(?!.*-y)/.test(normalized)) {
    normalized = normalized.replace(/install/, "install -y");
  }

  if (platform === "linux" && /\byum\s+install\b(?!.*-y)/.test(normalized)) {
    normalized = normalized.replace(/install/, "install -y");
  }

  return normalized;
}

function validateCommand(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked dangerous command: "${command}"`;
    }
  }

  for (const pattern of INTERACTIVE_PATTERNS) {
    if (pattern.test(command)) {
      const fixed = normalizeCommand(command);
      if (fixed !== command) return null;
      return `Interactive command may hang: "${command}". Add non-interactive flags.`;
    }
  }

  return null;
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return { text: output, truncated: false };
  }

  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  const removed = output.length - MAX_OUTPUT_CHARS;

  return {
    text:
      output.slice(0, half) +
      `\n\n... [truncated ${removed} chars] ...\n\n` +
      output.slice(-half),
    truncated: true,
  };
}

function sanitizePaths(text: string, cwd: string): string {
  return text.replace(
    new RegExp(cwd.replace(/[/\\]/g, "[/\\\\]"), "g"),
    "[PROJECT_ROOT]"
  );
}

function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { command, cwd, timeoutSec, env } = options;
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawnShell(command, cwd, env);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000);
    }, timeoutSec * 1000);

    const append = (chunk: Buffer, target: "stdout" | "stderr") => {
      const next =
        (target === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_BUFFER_BYTES) {
        child.kill("SIGTERM");
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };

    child.stdout?.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || error.message,
        exitCode: 1,
        signal: null,
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

function formatResult(
  command: string,
  cwd: string,
  result: RunCommandResult,
  platform: Platform
): string {
  const sections: string[] = [
    `Command: ${command}`,
    `Shell: ${getShellLabel(platform)} (${platform})`,
    `Working directory: ${cwd}`,
    `Duration: ${result.durationMs}ms`,
  ];

  if (result.timedOut) {
    sections.push("Status: timed out");
    return sections.join("\n");
  }

  sections.push(`Exit code: ${result.exitCode ?? "unknown"}`);

  if (result.stdout.trim()) {
    const { text, truncated } = truncateOutput(
      sanitizePaths(result.stdout.trim(), cwd)
    );
    sections.push(`STDOUT:\n${text}`);
    if (truncated) sections.push("(stdout truncated)");
  }

  if (result.stderr.trim()) {
    const { text, truncated } = truncateOutput(
      sanitizePaths(result.stderr.trim(), cwd)
    );
    sections.push(`STDERR:\n${text}`);
    if (truncated) sections.push("(stderr truncated)");
  }

  if (!result.stdout.trim() && !result.stderr.trim()) {
    sections.push("Command completed with no output.");
  }

  if (result.exitCode !== 0) {
    sections.unshift("Command failed.");
  }

  return sections.join("\n\n");
}

async function ensureProjectDir(cwd: string) {
  await fs.mkdir(cwd, { recursive: true });
}

export const bashTool = tool(
  async (
    { command, working_directory, timeout, description },
    toolConfig: any
  ) => {
    const projectId = toolConfig.configurable?.projectId;
    const userId = toolConfig.configurable?.userId;

    if (!userId || !projectId) {
      return "Missing userId or projectId in tool configuration.";
    }

    let cwd: string;
    try {
      cwd = resolveProjectPath(
        userId,
        projectId,
        working_directory || "."
      );
    } catch (error: any) {
      return error.message;
    }

    await ensureProjectDir(getProjectRoot(userId, projectId));
    await ensureProjectDir(cwd);

    let normalizedCommand = normalizeCommand(command);
    const validationError = validateCommand(normalizedCommand);
    if (validationError) return validationError;

    if (description) {
      console.log(`[bash] ${description}`);
    }

    const timeoutSec = Math.min(
      Math.max(timeout ?? DEFAULT_TIMEOUT_SEC, MIN_TIMEOUT_SEC),
      MAX_TIMEOUT_SEC
    );

    const result = await runCommand({
      command: normalizedCommand,
      cwd,
      timeoutSec,
    });

    if (result.timedOut) {
      return [
        `Command timed out after ${timeoutSec}s`,
        `Command: ${normalizedCommand}`,
        `Working directory: ${cwd}`,
        result.stdout.trim()
          ? `Partial STDOUT:\n${truncateOutput(sanitizePaths(result.stdout.trim(), cwd)).text}`
          : "",
        result.stderr.trim()
          ? `Partial STDERR:\n${truncateOutput(sanitizePaths(result.stderr.trim(), cwd)).text}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    return formatResult(normalizedCommand, cwd, result, getPlatform());
  },
  {
    name: "bash",
    description:
      "Run a shell command in the project sandbox. " +
      "Uses PowerShell on Windows, zsh on macOS, and bash on Linux. " +
      "Commands run inside public/working-dir/project-{userId}-{projectId}. " +
      "Supports optional working_directory (relative to project root), timeout, and description. " +
      "Destructive or interactive commands are blocked or auto-fixed when possible.",
    schema: z.object({
      command: z
        .string()
        .min(1)
        .max(8000)
        .describe("Shell command to execute"),
      working_directory: z
        .string()
        .optional()
        .describe(
          "Optional subdirectory relative to project root. Defaults to project root."
        ),
      timeout: z
        .number()
        .min(MIN_TIMEOUT_SEC)
        .max(MAX_TIMEOUT_SEC)
        .optional()
        .describe(`Timeout in seconds (default: ${DEFAULT_TIMEOUT_SEC}, max: ${MAX_TIMEOUT_SEC})`),
      description: z
        .string()
        .optional()
        .describe("Short description of what this command does"),
    }),
  }
);

export const selectedBashTool = {
  bash: bashTool,
} as Record<string, typeof bashTool>;
