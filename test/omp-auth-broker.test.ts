import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { OmpAuthBrokerCli, isUnsupportedRpcPreAuthPrompt } from "../src/providers/omp-auth-broker.js";

const fixture = resolve(process.cwd(), "test", "fixtures", "fake-omp-auth-broker.mjs");

function setup(interactiveTerminal = true): {
  root: string;
  isolation: { homeDir: string; agentDir: string; rejectUntrustedExtensions: true };
  runner: OmpAuthBrokerCli;
} {
  const root = mkdtempSync(join(tmpdir(), "superai-auth-broker-"));
  const isolation = {
    homeDir: join(root, "home"),
    agentDir: join(root, "agent"),
    rejectUntrustedExtensions: true as const,
  };
  mkdirSync(join(root, "project"), { recursive: true });
  return {
    root,
    isolation,
    runner: new OmpAuthBrokerCli({
      executable: process.execPath,
      versionContract: process.version,
      runtimePrefixArgs: [fixture],
      cwd: join(root, "project"),
      isolation,
      interactiveTerminal,
    }),
  };
}

test("official OMP auth-broker fallback uses the isolated local vault and a fixed argv", async () => {
  const prior = {
    url: process.env.OMP_AUTH_BROKER_URL,
    token: process.env.OMP_AUTH_BROKER_TOKEN,
    neuralwatt: process.env.NEURALWATT_API_KEY,
    piBorrow: process.env.PI_AUTH_NO_BORROW,
  };
  process.env.OMP_AUTH_BROKER_URL = "https://hostile.invalid";
  process.env.OMP_AUTH_BROKER_TOKEN = "must-not-cross";
  process.env.NEURALWATT_API_KEY = "must-not-cross";
  process.env.PI_AUTH_NO_BORROW = "must-not-cross";
  const { root, isolation, runner } = setup();
  try {
    await runner.login("perplexity");
    const invocation = JSON.parse(readFileSync(join(isolation.homeDir, "launch", "fake-auth-broker-invocation.json"), "utf8")) as {
      args: string[];
      cwd: string;
      environment: Record<string, string | undefined>;
    };
    assert.deepEqual(invocation.args, ["auth-broker", "login", "perplexity"]);
    assert.equal(resolve(invocation.cwd), resolve(isolation.homeDir, "launch"));
    const agentDirectory = invocation.environment.PI_CODING_AGENT_DIR;
    const home = invocation.environment.HOME;
    const userProfile = invocation.environment.USERPROFILE;
    assert.ok(agentDirectory);
    assert.ok(home);
    assert.ok(userProfile);
    assert.equal(resolve(agentDirectory), resolve(isolation.agentDir));
    assert.equal(resolve(home), resolve(isolation.homeDir));
    assert.equal(resolve(userProfile), resolve(isolation.homeDir));
    assert.equal(invocation.environment.OMP_AUTH_BROKER_URL, undefined);
    assert.equal(invocation.environment.OMP_AUTH_BROKER_TOKEN, undefined);
    assert.equal(invocation.environment.NEURALWATT_API_KEY, undefined);
    assert.equal(invocation.environment.PI_AUTH_NO_BORROW, "1");
  } finally {
    restoreEnvironment("OMP_AUTH_BROKER_URL", prior.url);
    restoreEnvironment("OMP_AUTH_BROKER_TOKEN", prior.token);
    restoreEnvironment("NEURALWATT_API_KEY", prior.neuralwatt);
    restoreEnvironment("PI_AUTH_NO_BORROW", prior.piBorrow);
    rmSync(root, { recursive: true, force: true });
  }
});

test("OMP auth-broker fallback is terminal-only and rejects argument injection", async () => {
  const nonInteractive = setup(false);
  try {
    await assert.rejects(nonInteractive.runner.login("perplexity"), /foreground interactive terminal/);
    assert.equal(existsSync(join(nonInteractive.isolation.homeDir, "launch", "fake-auth-broker-invocation.json")), false);
  } finally {
    rmSync(nonInteractive.root, { recursive: true, force: true });
  }

  const interactive = setup();
  try {
    await assert.rejects(interactive.runner.login("--via=attacker"), /provider id is invalid/);
    await assert.rejects(interactive.runner.login("perplexity --via=attacker"), /provider id is invalid/);
  } finally {
    rmSync(interactive.root, { recursive: true, force: true });
  }
});

test("official OMP logout uses the same fixed local-vault route", async () => {
  const fixtureState = setup();
  try {
    await fixtureState.runner.logout("github-copilot");
    const invocation = JSON.parse(readFileSync(join(fixtureState.isolation.homeDir, "launch", "fake-auth-broker-invocation.json"), "utf8")) as {
      args: string[];
    };
    assert.deepEqual(invocation.args, ["auth-broker", "logout", "github-copilot"]);
  } finally {
    rmSync(fixtureState.root, { recursive: true, force: true });
  }
});

test("OMP auth-broker fallback refuses remote broker configuration before spawn", async () => {
  const fixtureState = setup();
  try {
    mkdirSync(fixtureState.isolation.agentDir, { recursive: true });
    writeFileSync(join(fixtureState.isolation.agentDir, "config.yml"), "auth:\n  broker:\n    url: https://remote.invalid\n    token: secret\n", "utf8");
    await assert.rejects(fixtureState.runner.login("perplexity"), /auth\.broker configuration/);
    assert.equal(existsSync(join(fixtureState.isolation.homeDir, "launch", "fake-auth-broker-invocation.json")), false);
  } finally {
    rmSync(fixtureState.root, { recursive: true, force: true });
  }
});

test("OMP auth-broker fallback enforces its exact runtime version", async () => {
  const root = mkdtempSync(join(tmpdir(), "superai-auth-broker-version-"));
  try {
    const runner = new OmpAuthBrokerCli({
      executable: process.execPath,
      versionContract: "v0.0.0-not-this-runtime",
      runtimePrefixArgs: [fixture],
      cwd: root,
      isolation: { homeDir: join(root, "home"), agentDir: join(root, "agent"), rejectUntrustedExtensions: true },
      interactiveTerminal: true,
    });
    await assert.rejects(runner.login("perplexity"), /requires exactly v0\.0\.0-not-this-runtime/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the audited RPC pre-auth prompt error selects the CLI fallback", () => {
  assert.equal(
    isUnsupportedRpcPreAuthPrompt(
      new Error("Provider 'perplexity' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in."),
      "perplexity",
    ),
    true,
  );
  assert.equal(isUnsupportedRpcPreAuthPrompt(new Error("HTTP 401"), "perplexity"), false);
  assert.equal(
    isUnsupportedRpcPreAuthPrompt(new Error("Provider 'anthropic' requires interactive prompts which are not supported in RPC mode."), "perplexity"),
    false,
  );
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
