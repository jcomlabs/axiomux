import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

interface PackageManifest {
  name?: string;
  author?: string;
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
}

const root = resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageManifest;

test("release commands use compiled files shipped in the package", () => {
  assert.equal(manifest.name, "axiomux-agent");
  assert.equal(manifest.author, "JC-OM");
  assert.equal(manifest.bin?.axiomux, "dist/scripts/cli-launcher.js");
  assert.equal(manifest.scripts?.["omp:install"], "node --disable-warning=ExperimentalWarning dist/scripts/install-omp.js");
  assert.ok(manifest.files?.includes("dist/src"));
  assert.ok(manifest.files?.includes("dist/scripts"));
  assert.ok(!manifest.files?.includes("scripts/install-omp.ts"));
  assert.ok(existsSync(resolve(root, "dist", "src", "cli.js")));
  assert.ok(existsSync(resolve(root, "dist", "scripts", "cli-launcher.js")));
  assert.ok(existsSync(resolve(root, "dist", "scripts", "install-omp.js")));
  assert.ok(existsSync(resolve(root, "assets", "axiomux-emblem.png")));
});
