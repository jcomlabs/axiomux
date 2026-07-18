import { randomUUID } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findProjectRoot } from "../src/config.js";
import {
  hashRegularFile,
  managedOmpExecutablePath,
  OMP_CONTRACT_VERSION,
  OMP_RELEASE_DIGESTS,
  ompPlatformKey,
  ompReleaseDownloadUrl,
  verifyOmpRuntime,
} from "../src/security/omp-runtime.js";

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com"]);

const root = findProjectRoot();
const target = managedOmpExecutablePath(root);
const expectedDigest = OMP_RELEASE_DIGESTS[ompPlatformKey()];
if (!expectedDigest) throw new Error(`No audited OMP digest exists for ${ompPlatformKey()}`);

if (existsSync(target)) {
  const currentDigest = hashRegularFile(target);
  if (currentDigest !== expectedDigest) {
    throw new Error(`Managed OMP already exists with unexpected bytes at ${target}; remove it manually after inspection`);
  }
  const verified = verifyOmpRuntime(target, OMP_CONTRACT_VERSION, root, process.env, "managed provider runtime");
  console.log(`OMP already installed and verified: ${target} (${verified.version}, sha256 ${verified.digest})`);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
const temporary = `${target}.download-${randomUUID()}`;
try {
  const response = await fetch(ompReleaseDownloadUrl(), {
    headers: { Accept: "application/octet-stream", "User-Agent": "Axiomux-OMP-installer" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) throw new Error(`OMP download failed with HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
    throw new Error(`OMP download redirected to an untrusted host: ${finalUrl.hostname}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`OMP download size is outside the allowed range: ${contentLengthHeader}`);
    }
  }

  let downloadedBytes = 0;
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        callback(downloadedBytes > MAX_DOWNLOAD_BYTES ? new Error("OMP download exceeded 512 MiB") : undefined, chunk);
      },
    }),
    createWriteStream(temporary, { flags: "wx", mode: 0o700 }),
  );
  const digest = hashRegularFile(temporary);
  if (digest !== expectedDigest) throw new Error(`OMP download digest mismatch; expected ${expectedDigest}, received ${digest}`);
  chmodSync(temporary, 0o700);
  renameSync(temporary, target);
  const verified = verifyOmpRuntime(target, OMP_CONTRACT_VERSION, root, process.env, "managed provider runtime");
  console.log(`OMP installed and verified: ${target} (${verified.version}, sha256 ${verified.digest})`);
} finally {
  rmSync(temporary, { force: true });
}
