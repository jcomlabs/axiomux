import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory/store.js";
import { assertAgentSourceIngestionAllowed, isPublicSourceAddress, sanitizeSourceProvenance, sourceApprovalLabel, SourceHub } from "../src/sources.js";

test("source address policy accepts only globally routable unicast", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) assert.equal(isPublicSourceAddress(address), true, address);
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "192.0.0.8",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "ff02::1",
  ])
    assert.equal(isPublicSourceAddress(address), false, address);
});

test("source URL provenance strips signed queries, fragments and userinfo", () => {
  const signed = "https://user:password@example.com/path/file?sig=SECRET_TOKEN&se=2099#fragment";
  assert.equal(sanitizeSourceProvenance(signed), "https://example.com/path/file");
  const approval = sourceApprovalLabel(signed);
  assert.match(approval, /^https:\/\/example\.com\/path\/file/);
  assert.doesNotMatch(approval, /user|password|SECRET_TOKEN|fragment/);
  assert.match(approval, /redacted/);
  assert.throws(() => assertAgentSourceIngestionAllowed(signed), /refuses URL userinfo, query strings and fragments/);
  assert.doesNotThrow(() => assertAgentSourceIngestionAllowed("https://example.com/visible/path"));
});

test("source hub records local provenance and blocks workspace escape", async () => {
  const directory = mkdtempSync(join(tmpdir(), "superai-source-"));
  try {
    writeFileSync(join(directory, "note.md"), "release evidence", "utf8");
    writeFileSync(join(directory, "second.md"), "second release evidence", "utf8");
    writeFileSync(join(directory, "redaction.md"), "password=abcdefghijklmnop", "utf8");
    const memory = new MemoryStore(join(directory, "state.db"));
    const hub = new SourceHub(memory, directory);
    const id = await hub.ingestFile("note.md");
    assert.equal(memory.getMemory(id)?.sourceLabel, "note.md");
    assert.equal(memory.getMemory(id)?.sourceUri, "workspace:///note.md");
    const redactedId = await hub.ingestFile("redaction.md");
    assert.doesNotMatch(memory.getMemory(redactedId)?.content ?? "", /abcdefghijklmnop/);
    assert.match(memory.getMemory(redactedId)?.content ?? "", /REDACTED/);
    await assert.rejects(hub.ingestFile("../outside.md"), /escapes the workspace root/);
    writeFileSync(join(directory, ".env"), "API_KEY=<redacted>", "utf8");
    await assert.rejects(hub.ingestFile(".env"), /Sensitive path denied/);
    mkdirSync(join(directory, ".superai"));
    writeFileSync(join(directory, ".superai", "audit.jsonl"), "private", "utf8");
    await assert.rejects(hub.ingestFile(".superai/audit.jsonl"), /Sensitive path denied/);
    for (const path of [".git/config", ".ssh/id_ed25519", "node_modules/pkg/index.js"]) {
      mkdirSync(join(directory, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(directory, ...path.split("/")), "sensitive", "utf8");
      await assert.rejects(hub.ingestFile(path), /Sensitive path denied/);
    }
    for (const path of [".npmrc", "credentials.json", "tokens.db"]) {
      writeFileSync(join(directory, path), "sensitive", "utf8");
      await assert.rejects(hub.ingestFile(path), /Sensitive path denied/);
    }
    await assert.rejects(hub.ingestUrl("http://127.0.0.1:8080/private"), /Private, reserved/);
    await assert.rejects(hub.ingestUrl("http://[::ffff:127.0.0.1]/private"), /Private, reserved/);
    const batch = await hub.ingestMany(["note.md", "second.md", "missing.md"], 2);
    assert.equal(batch.filter((item) => item.memoryId).length, 2);
    assert.match(batch[2]?.error ?? "", /ENOENT/);
    memory.close();
  } finally {
    rmSync(resolve(directory), { recursive: true, force: true });
  }
});
