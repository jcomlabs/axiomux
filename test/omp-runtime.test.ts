import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashRegularFile, OMP_CONTRACT_VERSION, OMP_RELEASE_DIGESTS, verifyOmpRuntime } from "../src/security/omp-runtime.js";

test("audited OMP v17.0.4 release manifest covers every supported upstream asset", () => {
  assert.equal(OMP_CONTRACT_VERSION, "omp/17.0.4");
  assert.deepEqual(Object.keys(OMP_RELEASE_DIGESTS).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  for (const digest of Object.values(OMP_RELEASE_DIGESTS)) assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(OMP_RELEASE_DIGESTS["win32-x64"], "326fb7df19a8a4516f129a52d60373b547f732c17f19d4c38700f3591d85aa73");
});

test("regular-file hashing is deterministic and does not trust a filename", () => {
  const root = mkdtempSync(join(tmpdir(), "superai-omp-digest-"));
  const path = join(root, "omp.exe");
  try {
    writeFileSync(path, "abc", "utf8");
    assert.equal(hashRegularFile(path), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    writeFileSync(path, "abd", "utf8");
    assert.notEqual(hashRegularFile(path), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-OMP test runtimes retain exact version-contract verification", () => {
  const result = verifyOmpRuntime(process.execPath, process.version, process.cwd(), process.env, "test runtime");
  assert.equal(result.version, process.version);
  assert.equal(result.digest, undefined);
  assert.throws(
    () => verifyOmpRuntime(process.execPath, "node/definitely-wrong", process.cwd(), process.env, "test runtime"),
    /requires exactly node\/definitely-wrong/u,
  );
});
