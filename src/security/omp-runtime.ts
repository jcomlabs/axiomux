import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./secrets.js";

export const OMP_CONTRACT_VERSION = "omp/17.0.4";
export const OMP_RELEASE_TAG = "v17.0.4";

export const OMP_RELEASE_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "omp-darwin-arm64",
  "darwin-x64": "omp-darwin-x64",
  "linux-arm64": "omp-linux-arm64",
  "linux-x64": "omp-linux-x64",
  "win32-x64": "omp-windows-x64.exe",
});

/** SHA-256 digests published by the official GitHub release v17.0.4. */
export const OMP_RELEASE_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "6a1cd4957ae3bb5179c315596b34d8d8b8d8638b03c18fd88c867cc38e199a18",
  "darwin-x64": "9b42964f99e505b53288a7b5583d9aafedd003e88b8212ceed773d5064cb374d",
  "linux-arm64": "d051556529090721e8a8fb66034697cd745fb4a92e1d3cbd485569ea683aab10",
  "linux-x64": "556ca88320ee1b65b7e2ba719e155ff3323d4f58b945565b654925eb61e71040",
  "win32-x64": "326fb7df19a8a4516f129a52d60373b547f732c17f19d4c38700f3591d85aa73",
});

const MAX_OMP_BINARY_BYTES = 512 * 1024 * 1024;

export function ompPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function managedOmpExecutablePath(projectRoot: string): string {
  const asset = OMP_RELEASE_ASSETS[ompPlatformKey()];
  if (!asset) throw new Error(`Unsupported OMP release platform ${ompPlatformKey()}`);
  return join(projectRoot, ".superai", "bin", `${OMP_RELEASE_TAG}-${asset}`);
}

export function ompReleaseDownloadUrl(): string {
  const asset = OMP_RELEASE_ASSETS[ompPlatformKey()];
  if (!asset) throw new Error(`Unsupported OMP release platform ${ompPlatformKey()}`);
  return `https://github.com/can1357/oh-my-pi/releases/download/${OMP_RELEASE_TAG}/${asset}`;
}

/**
 * Verifies bytes before executing the external runtime. Test wrappers use a
 * non-OMP version contract and therefore exercise version pinning only.
 */
export function verifyOmpRuntime(
  executable: string,
  expectedVersion: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  label = "provider runtime",
): { version: string; digest?: string } {
  if (!expectedVersion.trim() || expectedVersion.length > 120 || /[\r\n\0]/u.test(expectedVersion)) {
    throw new Error("OMP version contract is invalid");
  }

  let digest: string | undefined;
  if (expectedVersion === OMP_CONTRACT_VERSION) {
    const platformKey = ompPlatformKey();
    const expectedDigest = OMP_RELEASE_DIGESTS[platformKey];
    if (!expectedDigest) throw new Error(`Unsupported OMP release platform ${platformKey}; no audited ${OMP_CONTRACT_VERSION} digest is available`);
    digest = hashRegularFile(executable);
    if (digest !== expectedDigest) {
      throw new Error(
        `OMP executable digest mismatch for ${platformKey}; expected official ${OMP_CONTRACT_VERSION} SHA-256 ${expectedDigest}, received ${digest}`,
      );
    }
  }

  let actual: string;
  try {
    actual = execFileSync(executable, ["--version"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch (error) {
    throw new Error(`Unable to verify ${label} ${expectedVersion}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  if (actual !== expectedVersion) throw new Error(`Unsupported ${label} ${actual || "unknown"}; Axiomux requires exactly ${expectedVersion}`);
  return { version: actual, ...(digest ? { digest } : {}) };
}

export function hashRegularFile(path: string): string {
  const canonical = realpathSync.native(path);
  const metadata = statSync(canonical);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_OMP_BINARY_BYTES) {
    throw new Error("OMP executable must be a non-empty regular file no larger than 512 MiB");
  }
  const descriptor = openSync(canonical, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}
