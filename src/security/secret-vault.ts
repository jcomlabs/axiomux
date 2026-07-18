import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { redactSecrets } from "./secrets.js";
import { secureStateDirectory, writePrivateFileAtomic } from "./state.js";
import { resolveTrustedExecutable } from "./executable.js";

const MAX_ENVELOPE_BYTES = 64 * 1024;

export interface SecretVaultCodec {
  protect(value: string): string;
  unprotect(value: string): string;
}

/**
 * Stores runtime credentials outside Git in an OS-user-bound envelope.
 * There is deliberately no plaintext fallback: on unsupported systems users
 * must provide the credential through the process environment instead.
 */
export class SecretVault {
  private readonly directory: string;
  private readonly codec: SecretVaultCodec;

  constructor(stateDirectory: string, codec?: SecretVaultCodec) {
    this.directory = join(stateDirectory, "secrets");
    this.codec = codec ?? platformCodec(dirname(resolve(stateDirectory)));
  }

  set(name: string, value: string): void {
    const key = validateName(name);
    const secret = value.trim();
    if (!secret || secret.length > 16_384) throw new Error("Secret must contain 1-16,384 characters");
    mkdirSync(this.directory, { recursive: true });
    const directorySecurity = secureStateDirectory(this.directory);
    if (!directorySecurity.hardened) throw new Error(`Could not secure the credential directory: ${directorySecurity.detail}`);
    const path = join(this.directory, `${key}.dpapi`);
    const envelope = this.codec.protect(secret);
    if (!envelope || Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES) {
      throw new Error("Protected credential envelope exceeded the safe size limit");
    }
    writePrivateFileAtomic(path, `${envelope}\n`);
  }

  get(name: string): string | undefined {
    const key = validateName(name);
    const path = join(this.directory, `${key}.dpapi`);
    let envelope: string;
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > MAX_ENVELOPE_BYTES) {
        throw new Error("credential envelope is not a bounded regular file");
      }
      envelope = readFileSync(path, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Could not read the encrypted credential: ${redactSecrets(String(error))}`);
    }
    if (!envelope) return undefined;
    const secret = this.codec.unprotect(envelope).trim();
    if (!secret) throw new Error("The encrypted credential decrypted to an empty value");
    if (secret.length > 16_384) throw new Error("The encrypted credential exceeded the safe size limit after decryption");
    return secret;
  }

  delete(name: string): boolean {
    const key = validateName(name);
    const path = join(this.directory, `${key}.dpapi`);
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(`Could not inspect the encrypted credential: ${redactSecrets(String(error))}`);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > MAX_ENVELOPE_BYTES) {
      throw new Error("Refusing to delete a credential path that is not a bounded regular file");
    }
    const directorySecurity = secureStateDirectory(this.directory);
    if (!directorySecurity.hardened) throw new Error(`Could not secure the credential directory before deletion: ${directorySecurity.detail}`);
    unlinkSync(path);
    return true;
  }
}

function platformCodec(rejectRoot: string): SecretVaultCodec {
  if (process.platform !== "win32") {
    return {
      protect: () => {
        throw new Error("Persistent credential storage currently requires Windows DPAPI; use a runtime environment variable on this platform");
      },
      unprotect: () => {
        throw new Error("This credential is protected with Windows DPAPI and cannot be opened on this platform");
      },
    };
  }
  const pwsh = resolveTrustedExecutable("pwsh", { rejectRoots: [rejectRoot] });
  return {
    protect: (value) => runDpapi(pwsh, "protect", value),
    unprotect: (value) => runDpapi(pwsh, "unprotect", value),
  };
}

function runDpapi(pwsh: string, operation: "protect" | "unprotect", input: string): string {
  const body =
    operation === "protect"
      ? "$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))"
      : "$p=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))";
  const encoded = Buffer.from(body, "utf16le").toString("base64");
  try {
    return execFileSync(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(`Windows DPAPI ${operation} failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
}

function validateName(name: string): string {
  const clean = name.trim().toLocaleLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(clean)) throw new Error("Credential name is invalid");
  return clean;
}
