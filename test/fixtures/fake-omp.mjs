import { createInterface } from "node:readline";

const approvalModeIndex = process.argv.indexOf("--approval-mode");
if (approvalModeIndex < 0 || process.argv[approvalModeIndex + 1] !== "always-ask") {
  process.stderr.write("unsafe approval mode\n");
  process.exit(64);
}

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
const lines = createInterface({ input: process.stdin });
let waitingTool = false;
let waitingLogin = false;
let waitingSteer = false;
let waitingApproval = false;
let lastText = "fake reply";

for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.type === "get_available_models") {
    send({
      id: frame.id,
      type: "response",
      command: frame.type,
      success: true,
      data: { models: [{ provider: "fake", id: "reliable", name: "Reliable", reasoning: true, input: ["text"] }] },
    });
  } else if (frame.type === "set_host_tools") {
    send({ id: frame.id, type: "response", command: frame.type, success: true, data: { toolNames: frame.tools.map((tool) => tool.name) } });
  } else if (frame.type === "prompt") {
    send({ id: frame.id, type: "response", command: frame.type, success: true, data: { agentInvoked: true } });
    if (frame.message === "error") {
      const message = { role: "assistant", content: [], stopReason: "error", errorStatus: 401, errorMessage: "token invalid" };
      send({ type: "message_end", message });
      send({ type: "agent_end", messages: [message] });
      continue;
    }
    if (frame.message === "steer-me") {
      waitingSteer = true;
      send({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
      send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private-thought-never-expose" } });
      continue;
    }
    if (frame.message === "approval-error") {
      waitingApproval = true;
      send({
        type: "extension_ui_request",
        id: "approval_select",
        method: "select",
        title: "Allow tool: write",
        message: "Path: safe.txt",
        options: ["Approve", "Deny"],
      });
      continue;
    }
    waitingTool = true;
    send({ type: "host_tool_call", id: "tool_req", toolCallId: "call_1", toolName: "echo", arguments: { value: frame.message } });
  } else if (frame.type === "steer" && waitingSteer) {
    waitingSteer = false;
    send({ id: frame.id, type: "response", command: frame.type, success: true });
    send({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "private-thought-never-expose" } });
    lastText = `steered:${frame.message}`;
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: lastText } });
    send({ type: "agent_end", messages: [] });
  } else if (frame.type === "follow_up" || frame.type === "abort") {
    send({ id: frame.id, type: "response", command: frame.type, success: true });
  } else if (frame.type === "host_tool_result" && waitingTool) {
    waitingTool = false;
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fake reply" } });
    send({ type: "agent_end", messages: [] });
  } else if (frame.type === "get_last_assistant_text") {
    send({ id: frame.id, type: "response", command: frame.type, success: true, data: { text: lastText } });
  } else if (frame.type === "get_login_providers") {
    send({
      id: frame.id,
      type: "response",
      command: frame.type,
      success: true,
      data: { providers: [{ id: "fake-oauth", name: "Fake OAuth", available: true, authenticated: false }] },
    });
  } else if (frame.type === "login") {
    waitingLogin = true;
    send({ type: "extension_ui_request", id: "login_input", method: "input", title: "OAuth code" });
  } else if (frame.type === "extension_ui_response" && waitingLogin) {
    waitingLogin = false;
    send({ id: "superai_2", type: "response", command: "login", success: true, data: { providerId: "fake-oauth" } });
  } else if (frame.type === "extension_ui_response" && waitingApproval) {
    waitingApproval = false;
    const message = { role: "assistant", content: [], stopReason: "error", errorStatus: 503, errorMessage: "provider died after write" };
    send({ type: "message_end", message });
    send({ type: "agent_end", messages: [message] });
  } else if (frame.type === "set_model") {
    send({ id: frame.id, type: "response", command: frame.type, success: true, data: { provider: frame.provider, id: frame.modelId } });
  }
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
