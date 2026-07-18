import { spawn } from "node:child_process";
import { buildChildEnvironment } from "../security/environment.js";
import { resolveWindowsSystemExecutable } from "../security/executable.js";
import { pinExecutableForSpawn } from "../tools/workspace-tools.js";
import { redactSecrets } from "../security/secrets.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export class CommandAdapter {
  private readonly executable: string;
  private readonly args: string[];

  constructor(
    private readonly command: string,
    private readonly timeoutMs = 180_000,
    private readonly envAllowlist: string[] = [],
    private readonly cwd = process.cwd(),
  ) {
    if (!this.command.trim()) throw new Error("Adapter command is not configured");
    const [executable, ...args] = splitCommand(this.command);
    if (!executable) throw new Error("Adapter command is empty");
    this.executable = pinExecutableForSpawn(executable, this.cwd);
    this.args = args;
  }

  describeCommand(): string {
    return `resolved executable=${this.executable}\ncomplete argv data=${JSON.stringify(this.args)}`;
  }

  run(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, this.args, {
        shell: false,
        cwd: this.cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnvironment(this.envAllowlist),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      };
      const timer = setTimeout(() => {
        terminateProcessTree(child);
        fail(new Error(`Adapter timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const abort = () => {
        terminateProcessTree(child);
        const error = new Error("Adapter execution aborted");
        error.name = "AbortError";
        fail(error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const append = (current: string, chunk: unknown): string => {
        const next = current + String(chunk);
        if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
          terminateProcessTree(child);
          throw new Error(`Adapter output exceeded ${MAX_OUTPUT_BYTES} bytes`);
        }
        return next;
      };
      child.stdout.on("data", (chunk) => {
        try {
          stdout = append(stdout, chunk);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = append(stderr, chunk);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.on("error", (error) => {
        fail(error);
      });
      child.stdin.on("error", (error) => {
        if (settled) return;
        terminateProcessTree(child);
        fail(new Error(`Adapter stdin failed: ${redactSecrets(error.message)}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (settled) return;
        if (code !== 0) {
          fail(new Error(`Adapter exited with ${code}: ${redactSecrets(stderr.trim() || stdout.trim())}`));
          return;
        }
        try {
          settled = true;
          resolve(JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          settled = true;
          resolve({ output: stdout.trim(), stderr: stderr.trim() });
        }
      });
      if (signal?.aborted) abort();
      else child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawn(resolveWindowsSystemExecutable("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
      return;
    } catch {
      // Fall through to the direct signal.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through if the process group already ended or could not be made.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* Already exited. */
  }
}

function splitCommand(value: string): string[] {
  const matches = value.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g) ?? [];
  return matches.map((part) => {
    const quoted = (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"));
    return quoted ? part.slice(1, -1).replace(/\\([\\"'])/g, "$1") : part;
  });
}
