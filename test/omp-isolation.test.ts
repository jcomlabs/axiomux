import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { prepareOmpIsolation } from "../src/security/omp-isolation.js";

test("strict OMP isolation refuses implicitly discovered executable code", () => {
  mkdirSync(join(process.cwd(), ".superai"), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-test-"));
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(project, ".omp", "extensions", "surprise.js"), "export default () => {};\n");
    assert.throws(
      () =>
        prepareOmpIsolation(
          {
            homeDir: home,
            agentDir: agent,
            rejectUntrustedExtensions: true,
          },
          project,
        ),
      /Untrusted OMP executable surface/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP isolation accepts a clean project with no executable discovery surfaces", () => {
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-test-"));
  try {
    const prepared = prepareOmpIsolation(
      {
        homeDir: join(root, "home"),
        agentDir: join(root, "agent"),
        rejectUntrustedExtensions: true,
      },
      join(root, "project"),
      ["todo", "web_search"],
    );
    assert.equal(existsSync(prepared.launchDir), true);
    const overlay = readFileSync(prepared.safetyConfigPath, "utf8");
    assert.match(overlay, /enableProjectConfig: false/);
    assert.match(overlay, /native/);
    assert.match(overlay, /todo: allow/);
    assert.match(overlay, /web_search: prompt/);
    assert.match(overlay, /workspace_read: allow/);
    assert.match(overlay, /workspace_write: allow/);
    assert.match(overlay, /browser: deny/);
    assert.match(overlay, /task: deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP isolation rejects filesystem, process and browser native tools", () => {
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-test-"));
  try {
    const isolation = {
      homeDir: join(root, "home"),
      agentDir: join(root, "agent"),
      rejectUntrustedExtensions: true,
    };
    for (const tool of ["read", "write", "bash", "python", "browser", "lsp", "inspect_image"]) {
      assert.throws(() => prepareOmpIsolation(isolation, join(root, "project"), [tool]), /refuses native tool/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP isolation rejects command-backed values in models.yml, including escaped YAML", () => {
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-model-command-"));
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    mkdirSync(agent, { recursive: true });
    const modelConfig = join(agent, "models.yml");
    const isolation = { homeDir: home, agentDir: agent, rejectUntrustedExtensions: true };
    writeFileSync(modelConfig, 'providers:\n  malicious:\n    apiKey: "!powershell -File evil.ps1"\n', "utf8");
    assert.throws(() => prepareOmpIsolation(isolation, join(root, "project")), /command-backed value/);
    writeFileSync(
      modelConfig,
      String.raw`providers:
  malicious:
    apiKey: "\u0021powershell -File evil.ps1"
`,
      "utf8",
    );
    assert.throws(() => prepareOmpIsolation(isolation, join(root, "project")), /command-backed value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP isolation rejects auth-broker config and command values before OMP startup", () => {
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-auth-broker-"));
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    mkdirSync(agent, { recursive: true });
    const configPath = join(agent, "config.yml");
    const isolation = { homeDir: home, agentDir: agent, rejectUntrustedExtensions: true };
    writeFileSync(configPath, "auth:\n  broker:\n    url: https://broker.example\n    token: fixed\n", "utf8");
    assert.throws(() => prepareOmpIsolation(isolation, join(root, "project")), /auth\.broker configuration/);
    writeFileSync(configPath, "auth.broker.url: https://broker.example\nauth.broker.token: fixed\n", "utf8");
    assert.throws(() => prepareOmpIsolation(isolation, join(root, "project")), /auth\.broker configuration/);
    writeFileSync(
      configPath,
      String.raw`webSearch:
  apiKey: "\u0021powershell -File evil.ps1"
`,
      "utf8",
    );
    assert.throws(() => prepareOmpIsolation(isolation, join(root, "project")), /command-backed value/);
    rmSync(configPath, { force: true });
    writeFileSync(join(agent, "auth-broker.token"), "unexpected", "utf8");
    assert.throws(() => prepareOmpIsolation(isolation, join(root, "project")), /auth-broker token file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP isolation blocks project MCP commands even though the safety overlay also disables discovery", () => {
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-test-"));
  try {
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { unsafe: { command: "node", args: ["evil.js"] } } }));
    assert.throws(
      () =>
        prepareOmpIsolation(
          {
            homeDir: join(root, "home"),
            agentDir: join(root, "agent"),
            rejectUntrustedExtensions: true,
          },
          project,
        ),
      /Untrusted MCP configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP isolation scans the isolated HOME plugin root and dotenv inputs", () => {
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-test-"));
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    mkdirSync(join(home, ".omp", "plugins"), { recursive: true });
    writeFileSync(join(home, ".omp", "plugins", "unsafe.js"), "export default () => {};\n");
    assert.throws(
      () => prepareOmpIsolation({ homeDir: home, agentDir: agent, rejectUntrustedExtensions: true }, join(root, "project")),
      /Untrusted OMP executable surface/,
    );
    rmSync(join(home, ".omp"), { recursive: true, force: true });
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, ".env"), "SECRET=unsafe\n");
    assert.throws(
      () => prepareOmpIsolation({ homeDir: home, agentDir: agent, rejectUntrustedExtensions: true }, join(root, "project")),
      /Untrusted environment file/,
    );
    rmSync(join(agent, ".env"), { force: true });
    mkdirSync(join(home, ".omp"), { recursive: true });
    writeFileSync(join(home, ".omp", ".env"), "SECRET=unsafe\n");
    assert.throws(
      () => prepareOmpIsolation({ homeDir: home, agentDir: agent, rejectUntrustedExtensions: true }, join(root, "project")),
      /Untrusted environment file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict OMP isolation also blocks legacy .pi discovery", () => {
  const root = mkdtempSync(join(process.cwd(), ".superai", "isolation-test-"));
  try {
    const project = join(root, "project");
    mkdirSync(join(project, ".pi", "hooks"), { recursive: true });
    writeFileSync(join(project, ".pi", "hooks", "legacy.js"), "export default () => {};\n");
    assert.throws(
      () =>
        prepareOmpIsolation(
          {
            homeDir: join(root, "home"),
            agentDir: join(root, "agent"),
            rejectUntrustedExtensions: true,
          },
          project,
        ),
      /Untrusted OMP executable surface/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
