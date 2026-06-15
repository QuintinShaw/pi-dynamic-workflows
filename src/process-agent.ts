import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import * as fs from "node:fs";
import type { AgentUsage } from "./agent.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";

export interface ProcessAgentResult {
  output: string;
  usage: AgentUsage;
}

interface PiJsonLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  done?: boolean;
}

const PI_PACKAGE_NAMES = [
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
];

function isRunnableNodeScript(filePath: string): boolean {
  return fs.existsSync(filePath) && /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function findPiPackageJsonFrom(startDir: string): string | undefined {
  let dir = startDir;
  while (dir !== dir.slice(0, dir.lastIndexOf("\\") + 1)) {
    const direct = join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(direct, "utf-8")) as { name?: string };
      if (pkg.name && PI_PACKAGE_NAMES.includes(pkg.name)) return direct;
    } catch { /* continue */ }
    for (const pkgName of PI_PACKAGE_NAMES) {
      const [scope, name] = pkgName.replace("@", "").split("/");
      const dep = join(dir, "node_modules", `@${scope}`, name, "package.json");
      if (fs.existsSync(dep)) return dep;
    }
    const parent = dir.slice(0, dir.lastIndexOf("\\"));
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolvePiCliScript(): string | undefined {
  // Try to find the pi CLI script by walking up from the current file
  const currentDir = __dirname;
  const pkgJson = findPiPackageJsonFrom(currentDir);
  if (pkgJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8")) as { bin?: string | Record<string, string> };
      const binPath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi ?? Object.values(pkg.bin ?? {})[0];
      if (binPath) {
        const candidate = join(pkgJson, "..", binPath);
        if (isRunnableNodeScript(candidate)) return candidate;
      }
    } catch { /* ignore */ }
  }

  // Fallback: check APPDATA/npm for pi.cmd
  const appdata = process.env.APPDATA;
  if (appdata) {
    const cliJs = join(
      appdata, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js",
    );
    if (fs.existsSync(cliJs)) return cliJs;
  }

  return undefined;
}

export interface ProcessAgentOptions {
  prompt: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onHistory?: (entry: { role: string; text: string }) => void;
}

/**
 * Run an agent in a separate OS process by spawning `pi --mode json`.
 * This provides full crash and memory isolation at the cost of higher overhead.
 * The child process runs in JSON mode where each line of stdout is a JSON event.
 */
export function runAgentInProcess(options: ProcessAgentOptions): Promise<ProcessAgentResult> {
  return new Promise((resolve, reject) => {
    const cliScript = resolvePiCliScript();
    if (!cliScript) {
      reject(
        new WorkflowError(
          "Could not resolve pi CLI script for process isolation. Set PI_CLI_SCRIPT env var.",
          WorkflowErrorCode.SPAWN_ERROR,
          { recoverable: true },
        ),
      );
      return;
    }

    const args = ["--mode", "json", "--cwd", options.cwd];
    if (options.model) args.push("--model", options.model);
    args.push(options.prompt);

    const child: ChildProcess = spawn(process.execPath, [cliScript, ...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure the child can find its config
        PI_CLI_SCRIPT: cliScript,
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let lastAssistantText = "";
    let usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    let settled = false;

    const settle = (result: ProcessAgentResult | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (child.pid && !child.killed) {
        try { child.kill(); } catch { /* best-effort */ }
      }
      if (err) reject(err);
      else if (result) resolve(result);
      else reject(new WorkflowError("Process agent produced no output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true }));
    };

    // Parse JSON lines from stdout
    const stdoutStream = child.stdout;
    if (!stdoutStream) {
      settle(null, new WorkflowError("Process agent stdout is null", WorkflowErrorCode.SPAWN_ERROR, { recoverable: true }));
      return;
    }
    const rl = createInterface({ input: stdoutStream });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      stdout += line + "\n";
      try {
        const event = JSON.parse(line) as PiJsonLine;
        if (event.type === "message" && event.message) {
          const msg = event.message;
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (typeof part === "object" && part !== null && "text" in part) {
                lastAssistantText += (part as { text: string }).text;
              }
            }
          }
          if (msg.usage) {
            usage.input += msg.usage.input_tokens ?? 0;
            usage.output += msg.usage.output_tokens ?? 0;
            usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
            usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
            usage.total = usage.input + usage.output;
          }
          options.onHistory?.({ role: msg.role ?? "unknown", text: lastAssistantText });
        }
        if (event.type === "done" || event.done) {
          settle({ output: lastAssistantText, usage });
        }
      } catch {
        // Not JSON — might be plain text output
        if (line.trim()) lastAssistantText += line + "\n";
      }
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // Handle abort signal
    if (options.signal) {
      const onAbort = () => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        settle(null, new Error("Subagent was aborted"));
      };
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        settle(null, new WorkflowError(
          `Process agent timed out after ${options.timeoutMs}ms`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ));
      }, options.timeoutMs);
    }

    child.on("error", (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      settle(null, new WorkflowError(
        `Failed to spawn process agent: ${err.message}`,
        WorkflowErrorCode.SPAWN_ERROR,
        { recoverable: true },
      ));
    });

    child.on("exit", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!settled) {
        if (code === 0 && lastAssistantText.trim()) {
          settle({ output: lastAssistantText.trim(), usage });
        } else if (code !== 0) {
          settle(null, new WorkflowError(
            `Process agent exited with code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
            WorkflowErrorCode.AGENT_FAILED,
            { recoverable: true },
          ));
        } else {
          settle({ output: lastAssistantText.trim(), usage });
        }
      }
    });
  });
}
