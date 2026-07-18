import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretVault, type SecretVaultCodec } from "../src/security/secret-vault.js";

const reversibleCodec: SecretVaultCodec = {
  protect: (value) => Buffer.from(`sealed:${value}`, "utf8").toString("base64"),
  unprotect: (value) =>
    Buffer.from(value, "base64")
      .toString("utf8")
      .replace(/^sealed:/, ""),
};

test("secret vault persists only a protected envelope and restores the value", () => {
  const root = mkdtempSync(join(tmpdir(), "superai-vault-"));
  try {
    const vault = new SecretVault(root, reversibleCodec);
    vault.set("neuralwatt", "sk-private-value");
    assert.equal(vault.get("neuralwatt"), "sk-private-value");
    vault.set("neuralwatt", "sk-rotated-value");
    assert.equal(vault.get("neuralwatt"), "sk-rotated-value");
    assert.equal(vault.delete("neuralwatt"), true);
    assert.equal(vault.get("neuralwatt"), undefined);
    assert.equal(vault.delete("neuralwatt"), false);
    vault.set("neuralwatt", "sk-size-check");
    writeFileSync(join(root, "secrets", "neuralwatt.dpapi"), "x".repeat(64 * 1024 + 1), "utf8");
    assert.throws(() => vault.get("neuralwatt"), /bounded regular file|safe size/i);
    assert.equal(vault.get("missing"), undefined);
    assert.throws(() => vault.set("../escape", "x"), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
