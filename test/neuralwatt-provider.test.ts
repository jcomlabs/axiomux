import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NeuralwattProvider } from "../src/providers/neuralwatt.js";
import { SecretVault, type SecretVaultCodec } from "../src/security/secret-vault.js";

const codec: SecretVaultCodec = {
  protect: (value) => Buffer.from(value).toString("base64"),
  unprotect: (value) => Buffer.from(value, "base64").toString("utf8"),
};

test("native Neuralwatt login validates, encrypts and generates a credential-free OMP catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-"));
  try {
    const vault = new SecretVault(join(root, ".superai"), codec);
    const requests: string[] = [];
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/quota")) return Response.json({ ok: true });
      return Response.json({
        data: [
          {
            id: "vendor/model-x",
            max_model_len: 200_000,
            metadata: { display_name: "Model X", capabilities: { reasoning: true, vision: true }, limits: { max_context_length: 200_000 } },
          },
        ],
      });
    };
    const provider = new NeuralwattProvider(root, fakeFetch as typeof fetch, vault);
    const result = await provider.login("sk-super-secret");
    assert.deepEqual(
      requests.map((url) => url.split("/").at(-1)),
      ["quota", "models"],
    );
    assert.equal(result.models[0]?.selector, "neuralwatt/vendor/model-x");
    assert.deepEqual(provider.runtimeEnvironmentForModel("openai-codex/gpt-test"), {});
    assert.equal(provider.runtimeEnvironmentForModel("neuralwatt/vendor/model-x").NEURALWATT_API_KEY, "sk-super-secret");
    const yaml = readFileSync(result.modelConfigPath, "utf8");
    assert.match(yaml, /NEURALWATT_API_KEY/);
    assert.match(yaml, /vendor\/model-x/);
    assert.doesNotMatch(yaml, /sk-super-secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Neuralwatt login does not store a rejected credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-reject-"));
  try {
    const vault = new SecretVault(join(root, ".superai"), codec);
    const provider = new NeuralwattProvider(root, async () => new Response(null, { status: 401 }) as Response, vault);
    await assert.rejects(provider.login("bad-key"), /rejected/);
    assert.equal(vault.get("neuralwatt"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Neuralwatt model discovery stops streaming responses at the byte limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-oversize-"));
  try {
    const vault = new SecretVault(join(root, ".superai"), codec);
    let request = 0;
    const provider = new NeuralwattProvider(
      root,
      async () => {
        request += 1;
        if (request === 1) return Response.json({ ok: true });
        const chunk = new Uint8Array(1024 * 1024);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      vault,
    );
    await assert.rejects(provider.login("sk-size-limited"), /exceeded the safe size limit/);
    assert.equal(vault.get("neuralwatt"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Neuralwatt login never overwrites an operator models.yml", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-custom-"));
  try {
    const agentDir = join(root, ".superai", "omp-runtime", "agent");
    mkdirSync(agentDir, { recursive: true });
    const modelPath = join(agentDir, "models.yml");
    const custom = "# operator-owned\nproviders:\n  local:\n    models: []\n";
    writeFileSync(modelPath, custom, "utf8");
    const vault = new SecretVault(join(root, ".superai"), codec);
    const provider = new NeuralwattProvider(root, catalogFetch, vault);
    await assert.rejects(provider.login("sk-would-be-valid"), /Refusing to overwrite existing OMP models\.yml/);
    assert.equal(readFileSync(modelPath, "utf8"), custom);
    assert.equal(vault.get("neuralwatt"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Neuralwatt recognizes a credential-free catalog written under the previous public brand", () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-brand-migration-"));
  try {
    const agentDir = join(root, ".superai", "omp-runtime", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.yml"),
      "# Generated by RelayLoom. Contains no credential; the key is supplied through an encrypted runtime vault.\nproviders:\n  neuralwatt:\n    models: []\n",
      "utf8",
    );
    const provider = new NeuralwattProvider(root, catalogFetch, new SecretVault(join(root, ".superai"), codec));
    assert.equal(provider.status().credentialState, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed Neuralwatt catalog fails closed when its credential is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-missing-"));
  const previousEnvironment = process.env.NEURALWATT_API_KEY;
  delete process.env.NEURALWATT_API_KEY;
  try {
    const vault = new SecretVault(join(root, ".superai"), codec);
    const provider = new NeuralwattProvider(root, catalogFetch, vault);
    await provider.login("sk-temporary");
    assert.equal(provider.logout(), true);
    assert.equal(provider.logout(), false);

    const status = provider.status();
    assert.equal(status.authenticated, false);
    assert.equal(status.credentialState, "missing");
    assert.match(status.error ?? "", /no API key is available/i);
    assert.throws(() => provider.runtimeEnvironmentForModel("neuralwatt/vendor/model-x"), /refused to start.*literal NEURALWATT_API_KEY placeholder/i);
    assert.deepEqual(provider.runtimeEnvironmentForModel("anthropic/claude-test"), {});
  } finally {
    if (previousEnvironment === undefined) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = previousEnvironment;
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed Neuralwatt catalog reports an unreadable user-bound credential and fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-neuralwatt-unreadable-"));
  const previousEnvironment = process.env.NEURALWATT_API_KEY;
  delete process.env.NEURALWATT_API_KEY;
  try {
    const workingVault = new SecretVault(join(root, ".superai"), codec);
    await new NeuralwattProvider(root, catalogFetch, workingVault).login("sk-user-bound");
    const unreadableVault = new SecretVault(join(root, ".superai"), {
      protect: codec.protect,
      unprotect: () => {
        throw new Error("wrong OS user");
      },
    });
    const provider = new NeuralwattProvider(root, catalogFetch, unreadableVault);

    const status = provider.status();
    assert.equal(status.authenticated, false);
    assert.equal(status.credentialState, "unreadable");
    assert.match(status.error ?? "", /could not be decrypted for this OS user/i);
    assert.throws(() => provider.runtimeEnvironmentForModel("neuralwatt/vendor/model-x"), /refused to start the provider runtime/i);
    assert.deepEqual(provider.runtimeEnvironmentForModel("openai-codex/gpt-test"), {});
  } finally {
    if (previousEnvironment === undefined) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = previousEnvironment;
    rmSync(root, { recursive: true, force: true });
  }
});

async function catalogFetch(input: string | URL | Request): Promise<Response> {
  return String(input).endsWith("/quota") ? Response.json({ ok: true }) : Response.json({ data: [{ id: "vendor/model-x", metadata: {} }] });
}
