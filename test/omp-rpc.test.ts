import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { OmpRpcClient } from "../src/rpc/omp-client.js";

const fixture = resolve(process.cwd(), "test", "fixtures", "fake-omp.mjs");

function createRpcFixture(source: string): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "superai-rpc-hostile-"));
  const path = join(root, "fake-omp.mjs");
  writeFileSync(path, source, "utf8");
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("OMP RPC client drives models, host tools and streamed turns", async () => {
  const deltas: string[] = [];
  const client = new OmpRpcClient({ executable: process.execPath, versionContract: process.version, extraArgs: [fixture], cwd: process.cwd() });
  await client.start();
  const models = await client.getModels();
  assert.equal(models[0]?.selector, "fake/reliable");
  await client.registerTools([
    {
      name: "echo",
      description: "Echo test",
      parameters: { type: "object" },
      execute: async (arguments_) => ({ content: [{ type: "text", text: String(arguments_.value) }] }),
    },
  ]);
  const result = await client.prompt("hello", (delta) => deltas.push(delta));
  assert.equal(result.text, "fake reply");
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(deltas, ["fake reply"]);
  await client.stop();
});

test("OMP RPC login stays inside the provider flow", async () => {
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [fixture],
    cwd: process.cwd(),
    uiHandler: async (request) => (request.method === "input" ? { value: "callback-code" } : undefined),
  });
  await client.start();
  assert.equal((await client.getLoginProviders())[0]?.id, "fake-oauth");
  await client.login("fake-oauth");
  await client.stop();
});

test("OMP RPC provider errors fail the turn instead of becoming an empty answer", async () => {
  const client = new OmpRpcClient({ executable: process.execPath, versionContract: process.version, extraArgs: [fixture], cwd: process.cwd() });
  await client.start();
  await assert.rejects(client.prompt("error"), /HTTP 401: token invalid/);
  await client.stop();
});

test("an approved native OMP select is consequential and blocks safe fallback", async () => {
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [fixture],
    cwd: process.cwd(),
    uiHandler: async (request) => (request.method === "select" ? { value: "Approve" } : undefined),
  });
  await client.start();
  await assert.rejects(client.prompt("approval-error"), /provider died after write/);
  assert.equal(client.approvedConsequentialAction, true);
  await client.stop();
});

test("OMP RPC refuses an executable outside its exact audited version contract", async () => {
  const client = new OmpRpcClient({ executable: process.execPath, versionContract: "omp/0.0.0", extraArgs: [fixture], cwd: process.cwd() });
  await assert.rejects(client.start(), /requires exactly omp\/0\.0\.0/);
});

test("strict OMP RPC passes the private system prompt by file and removes it after startup", async () => {
  const probe = createRpcFixture(`
import { readFileSync } from "node:fs";
const index = process.argv.indexOf("--system-prompt");
if (index < 0) process.exit(70);
const path = process.argv[index + 1];
if (!path || path.includes("PRIVATE_PROMPT_SENTINEL")) process.exit(71);
if (readFileSync(path, "utf8") !== "PRIVATE_PROMPT_SENTINEL") process.exit(72);
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdin.resume();
`);
  const root = mkdtempSync(join(tmpdir(), "superai-private-prompt-"));
  const isolation = { homeDir: join(root, "home"), agentDir: join(root, "agent"), rejectUntrustedExtensions: true };
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [probe.path],
    cwd: root,
    systemPrompt: "PRIVATE_PROMPT_SENTINEL",
    isolation,
  });
  try {
    await client.start();
    assert.deepEqual(
      readdirSync(isolation.agentDir).filter((name) => name.startsWith(".superai-system-prompt-")),
      [],
    );
  } finally {
    await client.stop().catch(() => undefined);
    probe.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP RPC disables borrowing credentials from desktop applications", async () => {
  const probe = createRpcFixture(`
if (process.env.PI_AUTH_NO_BORROW !== "1") process.exit(73);
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdin.resume();
`);
  const root = mkdtempSync(join(tmpdir(), "superai-no-auth-borrow-"));
  const prior = process.env.PI_AUTH_NO_BORROW;
  process.env.PI_AUTH_NO_BORROW = "0";
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [probe.path],
    cwd: root,
    isolation: { homeDir: join(root, "home"), agentDir: join(root, "agent"), rejectUntrustedExtensions: true },
  });
  try {
    await client.start();
  } finally {
    await client.stop().catch(() => undefined);
    if (prior === undefined) delete process.env.PI_AUTH_NO_BORROW;
    else process.env.PI_AUTH_NO_BORROW = prior;
    probe.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OMP RPC strict isolation rejects named profiles and runtime-control environment variables", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-omp-strict-options-"));
  try {
    const isolation = { homeDir: join(root, "home"), agentDir: join(root, "agent"), rejectUntrustedExtensions: true };
    const profiled = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      profile: "personal",
      isolation,
    });
    await assert.rejects(profiled.start(), /Named OMP profiles/);
    const injected = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      envAllowlist: ["NODE_OPTIONS"],
      isolation,
    });
    await assert.rejects(injected.start(), /runtime-control environment variable/);
    const homeOverride = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      envAllowlist: ["HOME"],
      isolation,
    });
    await assert.rejects(homeOverride.start(), /runtime-control environment variable/);
    const borrowAllowlist = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      envAllowlist: ["PI_AUTH_NO_BORROW"],
      isolation,
    });
    await assert.rejects(borrowAllowlist.start(), /runtime-control environment variable PI_AUTH_NO_BORROW/);
    const neuralwattAllowlist = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      envAllowlist: ["NEURALWATT_API_KEY"],
      isolation,
    });
    await assert.rejects(neuralwattAllowlist.start(), /cannot expose the Neuralwatt provider secret/);
    const crossProviderSecret = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      model: "openai-codex/fake",
      environmentOverrides: { NEURALWATT_API_KEY: "must-not-leak" },
      isolation,
    });
    await assert.rejects(crossProviderSecret.start(), /only be injected into a Neuralwatt model child/);
    const runtimeOverride = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      model: "neuralwatt/fake",
      environmentOverrides: { HOME: "unsafe-override" },
      isolation,
    });
    await assert.rejects(runtimeOverride.start(), /cannot replace runtime-control variable HOME/);
    const borrowOverride = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      environmentOverrides: { PI_AUTH_NO_BORROW: "0" },
      isolation,
    });
    await assert.rejects(borrowOverride.start(), /cannot replace runtime-control variable PI_AUTH_NO_BORROW/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OMP RPC refuses parser-escape and compact extension arguments", async () => {
  const terminator = new OmpRpcClient({ executable: process.execPath, versionContract: process.version, extraArgs: ["--", fixture], cwd: process.cwd() });
  await assert.rejects(terminator.start(), /runtime override/);
  const compactExtension = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: ["-eunsafe.js", fixture],
    cwd: process.cwd(),
  });
  await assert.rejects(compactExtension.start(), /runtime override/);
});

test("stopping OMP aborts in-flight host tools", async () => {
  let aborted = false;
  const client = new OmpRpcClient({ executable: process.execPath, versionContract: process.version, extraArgs: [fixture], cwd: process.cwd() });
  await client.start();
  await client.registerTools([
    {
      name: "echo",
      description: "Wait for abort",
      parameters: { type: "object" },
      execute: async (_arguments, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    },
  ]);
  const turn = assert.rejects(client.prompt("wait"), /exited/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.stop();
  await turn;
  assert.equal(aborted, true);
});

test("OMP RPC steers a live turn and exposes only reasoning activity metadata", async () => {
  const activities: Array<{ label: string; detail?: string }> = [];
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [fixture],
    cwd: process.cwd(),
    onActivity: (event) => activities.push({ label: event.label, ...(event.detail ? { detail: event.detail } : {}) }),
  });
  await client.start();
  const turn = client.prompt("steer-me");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.turnActive, true);
  await client.steer("keep the work, add tests");
  const result = await turn;
  assert.equal(result.text, "steered:keep the work, add tests");
  const serialized = JSON.stringify(activities);
  assert.match(serialized, /reasoning/i);
  assert.doesNotMatch(serialized, /private-thought-never-expose/);
  await client.stop();
});

test("fresh isolated login uses a credential-free bootstrap model and removes it on shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-omp-bootstrap-"));
  try {
    const agentDir = join(root, "agent");
    const client = new OmpRpcClient({
      executable: process.execPath,
      versionContract: process.version,
      extraArgs: [fixture],
      cwd: process.cwd(),
      tools: [],
      bootstrapWithoutModel: true,
      isolation: { homeDir: join(root, "home"), agentDir, rejectUntrustedExtensions: true },
    });
    await client.start();
    assert.equal(existsSync(join(agentDir, "models.yml")), true);
    await client.stop();
    assert.equal(existsSync(join(agentDir, "models.yml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OMP RPC fails closed before parsing an oversized JSONL frame", async () => {
  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    send({ type: "oversized", padding: "x".repeat(1024 * 1024) });
  }
}
`);
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await client.start();
    await assert.rejects(client.prompt("overflow"), /RPC frame exceeded 1048576 bytes/);
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC rejects oversized host-tool arguments without invoking the tool", async () => {
  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "set_host_tools") send({ type: "response", id: frame.id, command: frame.type, success: true });
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    send({ type: "host_tool_call", id: "large_args", toolCallId: "large_args_call", toolName: "echo", arguments: { payload: "x".repeat(128 * 1024 + 1) } });
  }
}
`);
  let executed = false;
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await client.start();
    await client.registerTools([
      {
        name: "echo",
        description: "Must not run",
        parameters: { type: "object" },
        execute: async () => {
          executed = true;
          return { content: [{ type: "text", text: "unexpected" }] };
        },
      },
    ]);
    await assert.rejects(client.prompt("large args"), /host tool arguments exceeded 131072 bytes/);
    assert.equal(executed, false);
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC executes at most four host tools concurrently", async () => {
  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let results = 0;
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "set_host_tools") send({ type: "response", id: frame.id, command: frame.type, success: true });
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    for (let index = 0; index < 6; index += 1) {
      send({ type: "host_tool_call", id: "parallel_" + index, toolCallId: "call_" + index, toolName: "echo", arguments: { index } });
    }
  }
  if (frame.type === "host_tool_result") {
    results += 1;
    if (results === 6) {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "limited" } });
      send({ type: "agent_end", messages: [] });
    }
  }
  if (frame.type === "get_last_assistant_text") send({ type: "response", id: frame.id, command: frame.type, success: true, data: { text: "limited" } });
}
`);
  let active = 0;
  let maximumActive = 0;
  let executed = 0;
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await client.start();
    await client.registerTools([
      {
        name: "echo",
        description: "Concurrency probe",
        parameters: { type: "object" },
        execute: async () => {
          executed += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 40));
          active -= 1;
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    ]);
    const result = await client.prompt("parallel");
    assert.equal(result.text, "limited");
    assert.equal(result.toolCalls, 6);
    assert.equal(executed, 4);
    assert.equal(maximumActive, 4);
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC terminates a turn that exceeds 64 host-tool calls", async () => {
  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "set_host_tools") send({ type: "response", id: frame.id, command: frame.type, success: true });
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    for (let index = 0; index < 65; index += 1) {
      send({ type: "host_tool_call", id: "flood_" + index, toolCallId: "flood_call_" + index, toolName: "echo", arguments: { index } });
    }
  }
}
`);
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await client.start();
    await client.registerTools([
      {
        name: "echo",
        description: "Flood probe",
        parameters: { type: "object" },
        execute: async () => new Promise(() => undefined),
      },
    ]);
    await assert.rejects(client.prompt("flood"), /exceeded 64 host tool calls/);
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC cancels the matching long host tool by targetId exactly once", async () => {
  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let resultSeen = false;
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "set_host_tools") send({ type: "response", id: frame.id, command: frame.type, success: true });
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    send({ type: "host_tool_call", id: "long_request", toolCallId: "long_tool_call", toolName: "echo", arguments: {} });
    setTimeout(() => {
      send({ type: "host_tool_cancel", targetId: "long_request" });
      send({ type: "host_tool_cancel", targetId: "long_request" });
    }, 20);
    setTimeout(() => {
      const text = resultSeen ? "unexpected-result" : "cancelled-clean";
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      send({ type: "agent_end", messages: [] });
    }, 70);
  }
  if (frame.type === "host_tool_result") resultSeen = true;
  if (frame.type === "get_last_assistant_text") {
    send({ type: "response", id: frame.id, command: frame.type, success: true, data: { text: resultSeen ? "unexpected-result" : "cancelled-clean" } });
  }
}
`);
  let abortEvents = 0;
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await client.start();
    await client.registerTools([
      {
        name: "echo",
        description: "Cancellation probe",
        parameters: { type: "object" },
        execute: async (_arguments, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                abortEvents += 1;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          }),
      },
    ]);
    const result = await client.prompt("cancel");
    assert.equal(result.text, "cancelled-clean");
    assert.equal(abortEvents, 1);
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC caps cumulative assistant output and isolates observer callback failures", async () => {
  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    for (let index = 0; index < 5; index += 1) {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(900000) } });
    }
  }
}
`);
  let deltas = 0;
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    onEvent: () => {
      throw new Error("observer failure");
    },
    onActivity: () => {
      throw new Error("activity failure");
    },
  });
  try {
    await client.start();
    await assert.rejects(
      client.prompt("large output", () => {
        deltas += 1;
        throw new Error("delta failure");
      }),
      /assistant output exceeded 4194304 bytes/,
    );
    assert.equal(deltas, 4);
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC caps cumulative private reasoning without retaining its content", async () => {
  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    for (let index = 0; index < 17; index += 1) {
      send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "r".repeat(1000000) } });
    }
  }
}
`);
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await client.start();
    await assert.rejects(client.prompt("large reasoning"), /reasoning stream exceeded 16777216 bytes/);
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC bounds model catalogs and extension UI option arrays", async () => {
  const modelHostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "get_available_models") {
    send({ type: "response", id: frame.id, command: frame.type, success: true, data: { models: Array.from({ length: 2049 }, (_, index) => ({ provider: "p", id: "m" + index })) } });
  }
}
`);
  const modelClient = new OmpRpcClient({ executable: process.execPath, versionContract: process.version, extraArgs: [modelHostile.path], cwd: process.cwd() });
  try {
    await modelClient.start();
    await assert.rejects(modelClient.getModels(), /at most 2048 entries/);
  } finally {
    await modelClient.stop();
    modelHostile.cleanup();
  }

  const uiHostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "login") send({ type: "extension_ui_request", id: "too_many_options", method: "select", options: Array(257).fill("option") });
}
`);
  const uiClient = new OmpRpcClient({ executable: process.execPath, versionContract: process.version, extraArgs: [uiHostile.path], cwd: process.cwd() });
  try {
    await uiClient.start();
    await assert.rejects(uiClient.login("fake"), /options must contain at most 256 strings/);
  } finally {
    await uiClient.stop();
    uiHostile.cleanup();
  }
});

test("OMP RPC rejects duplicate host-tool registration and oversized tool results", async () => {
  const duplicateClient = new OmpRpcClient({ executable: process.execPath, versionContract: process.version, extraArgs: [fixture], cwd: process.cwd() });
  await duplicateClient.start();
  try {
    const duplicate = {
      name: "echo",
      description: "Duplicate probe",
      parameters: { type: "object" },
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    };
    await assert.rejects(duplicateClient.registerTools([duplicate, duplicate]), /Duplicate host tool name/);
  } finally {
    await duplicateClient.stop();
  }

  const hostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let lastText = "missing";
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "set_host_tools") send({ type: "response", id: frame.id, command: frame.type, success: true });
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    send({ type: "host_tool_call", id: "large_result", toolCallId: "large_result_call", toolName: "echo", arguments: {} });
  }
  if (frame.type === "host_tool_result") {
    lastText = frame.isError && String(frame.result?.content?.[0]?.text).includes("262144") ? "bounded-result" : "unsafe-result";
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: lastText } });
    send({ type: "agent_end", messages: [] });
  }
  if (frame.type === "get_last_assistant_text") send({ type: "response", id: frame.id, command: frame.type, success: true, data: { text: lastText } });
}
`);
  const client = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [hostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await client.start();
    await client.registerTools([
      {
        name: "echo",
        description: "Large result probe",
        parameters: { type: "object" },
        execute: async () => ({ content: [{ type: "text", text: "x".repeat(300_000) }] }),
      },
    ]);
    assert.equal((await client.prompt("large result")).text, "bounded-result");
  } finally {
    await client.stop();
    hostile.cleanup();
  }
});

test("OMP RPC terminates tiny-frame and concurrent UI floods", async () => {
  const frameHostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "prompt") {
    send({ type: "response", id: frame.id, command: "prompt", success: true });
    for (let index = 0; index < 10001; index += 1) send({ type: "noise", index });
  }
}
`);
  const frameClient = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [frameHostile.path],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  try {
    await frameClient.start();
    await assert.rejects(frameClient.prompt("frame flood"), /exceeded 10000 RPC frames in one turn/);
  } finally {
    await frameClient.stop();
    frameHostile.cleanup();
  }

  const uiHostile = createRpcFixture(String.raw`
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "login") {
    for (let index = 0; index < 9; index += 1) send({ type: "extension_ui_request", id: "ui_" + index, method: "confirm", title: "Confirm" });
  }
}
`);
  const uiClient = new OmpRpcClient({
    executable: process.execPath,
    versionContract: process.version,
    extraArgs: [uiHostile.path],
    cwd: process.cwd(),
    uiHandler: async () => new Promise(() => undefined),
  });
  try {
    await uiClient.start();
    await assert.rejects(uiClient.login("fake"), /exceeded 8 concurrent UI requests/);
  } finally {
    await uiClient.stop();
    uiHostile.cleanup();
  }
});
