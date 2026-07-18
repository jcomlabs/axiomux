import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { buildChildEnvironment } from "../security/environment.js";
import { resolveWindowsSystemExecutable } from "../security/executable.js";
import { prepareOmpIsolation, type OmpIsolation } from "../security/omp-isolation.js";
import { verifyOmpRuntime } from "../security/omp-runtime.js";
import { redactSecrets } from "../security/secrets.js";

const MAX_LOGIN_MS = 15 * 60_000;
const providerPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export interface OmpAuthBrokerCliOptions {
  executable: string;
  versionContract: string;
  cwd: string;
  isolation: OmpIsolation;
  /** Must only be true for the foreground CLI attached to the user's terminal. */
  interactiveTerminal: boolean;
  /** Test harness support. Production OMP contracts refuse all prefix arguments. */
  runtimePrefixArgs?: readonly string[];
}

/**
 * Runs OMP's official local credential-vault command for flows that RPC cannot
 * drive because they prompt before emitting an authorization URL. This is not
 * the remote auth-broker client: URL/token discovery is rejected by the strict
 * isolation scan and `--via` can never enter the fixed argument vector.
 */
export class OmpAuthBrokerCli {
  private readonly executable: string;
  private readonly prefix: string[];

  constructor(private readonly options: OmpAuthBrokerCliOptions) {
    if (!isAbsolute(options.executable)) throw new Error("OMP auth-broker executable must be an absolute path");
    this.executable = realpathSync.native(options.executable);
    if (!statSync(this.executable).isFile()) throw new Error("OMP auth-broker executable must be a regular file");
    if (!options.versionContract.trim() || options.versionContract.length > 120 || /[\r\n\0]/u.test(options.versionContract)) {
      throw new Error("OMP auth-broker version contract is invalid");
    }
    this.prefix = validateRuntimePrefix(options.runtimePrefixArgs ?? [], options.versionContract);
  }

  login(providerId: string): Promise<void> {
    return this.runInteractive("login", providerId);
  }

  logout(providerId: string): Promise<void> {
    return this.runInteractive("logout", providerId);
  }

  private async runInteractive(action: "login" | "logout", providerId: string): Promise<void> {
    const provider = validateProviderId(providerId);
    if (!this.options.interactiveTerminal) {
      throw new Error(`OMP auth-broker ${action} requires a foreground interactive terminal; it is not available through the web UI or redirected stdin`);
    }

    // This performs the same executable/config inspection as every RPC child.
    // In particular it refuses auth.broker URL/token configuration and token
    // files before the official local command gets a chance to discover them.
    const prepared = prepareOmpIsolation(this.options.isolation, this.options.cwd, []);
    const isolatedEnvironment: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      HOME: this.options.isolation.homeDir,
      USERPROFILE: this.options.isolation.homeDir,
      APPDATA: join(this.options.isolation.homeDir, "AppData", "Roaming"),
      LOCALAPPDATA: join(this.options.isolation.homeDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(this.options.isolation.homeDir, ".config"),
      PI_CODING_AGENT_DIR: this.options.isolation.agentDir,
      PI_AUTH_NO_BORROW: "1",
    };
    for (const directory of [isolatedEnvironment.APPDATA, isolatedEnvironment.LOCALAPPDATA, isolatedEnvironment.XDG_CONFIG_HOME]) {
      if (directory) mkdirSync(directory, { recursive: true });
    }
    const environment = buildChildEnvironment([], isolatedEnvironment);
    verifyOmpRuntime(this.executable, this.options.versionContract, prepared.launchDir, environment, "OMP auth-broker runtime");

    const child = spawn(this.executable, [...this.prefix, "auth-broker", action, provider], {
      cwd: prepared.launchDir,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: false,
    });
    await waitForInteractiveChild(child, action, provider);
  }
}

/** Exact OMP RPC error emitted when onPrompt happens before onAuth. */
export function isUnsupportedRpcPreAuthPrompt(error: unknown, providerId: string): boolean {
  const provider = validateProviderId(providerId);
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Provider '${provider}' requires interactive prompts`) && message.includes("not supported in RPC mode");
}

function validateProviderId(value: string): string {
  const provider = value.trim().toLocaleLowerCase();
  if (!providerPattern.test(provider)) throw new Error("OMP auth-broker provider id is invalid");
  return provider;
}

function validateRuntimePrefix(values: readonly string[], versionContract: string): string[] {
  if (versionContract.startsWith("omp/") && values.length) {
    throw new Error("Audited OMP auth-broker runtime does not permit wrapper or prefix arguments");
  }
  if (values.length > 1) throw new Error("OMP auth-broker test runtime accepts at most one prefix argument");
  return values.map((value) => {
    if (!isAbsolute(value) || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("OMP auth-broker runtime prefix must be one absolute file path");
    }
    const canonical = realpathSync.native(value);
    if (!statSync(canonical).isFile()) throw new Error("OMP auth-broker runtime prefix must be a regular file");
    return canonical;
  });
}

function waitForInteractiveChild(child: ChildProcess, action: string, provider: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result();
    };
    const timer = setTimeout(() => {
      terminateChild(child);
      finish(() => reject(new Error(`OMP auth-broker ${action} timed out for ${provider}`)));
    }, MAX_LOGIN_MS);
    child.once("error", (error) => finish(() => reject(new Error(`Could not start OMP auth-broker ${action}: ${redactSecrets(error.message)}`))));
    child.once("exit", (code, signal) =>
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`OMP auth-broker ${action} exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}`));
      }),
    );
  });
}

function terminateChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawn(resolveWindowsSystemExecutable("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref();
      return;
    } catch {
      // Fall through to direct termination.
    }
  }
  child.kill("SIGTERM");
}
