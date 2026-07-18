import {
  ERROR_KEYS,
  INVALID_FIELD_KEYS,
  MEMORY_KIND_KEYS,
  MEMORY_REVIEW_KEYS,
  normalizeLocale,
  persistLocale,
  readStoredLocale,
  traceDetailDescriptor,
  traceTitleDescriptor,
  translate,
} from "./locales.js";

const state = {
  projects: [],
  sessions: [],
  providers: [],
  models: [],
  projectId: undefined,
  sessionId: undefined,
  activeTaskId: undefined,
  events: undefined,
  traceCount: 0,
  streamingMessage: undefined,
  approvalQueue: [],
  activeApproval: undefined,
  routing: undefined,
  memoryPayload: undefined,
  locale: readStoredLocale(window.localStorage),
};

const byId = (id) => document.getElementById(id);
const projectList = byId("project-list");
const sessionList = byId("session-list");
const messages = byId("messages");
const emptyState = byId("empty-state");
const providerSelect = byId("provider-select");
const modelSelect = byId("model-select");
const messageInput = byId("message-input");
const sendButton = byId("send-button");
const sendLabel = byId("send-label");
const activeTask = byId("active-task");
const taskStatus = byId("task-status");
const traceList = byId("trace-list");
const memoryDrawer = byId("memory-drawer");
const drawerBackdrop = byId("drawer-backdrop");
const toast = byId("toast");
const approvalDialog = byId("approval-dialog");
const approvalDescription = byId("approval-description");
const routingDialog = byId("routing-dialog");
const routingForm = byId("routing-form");
const fusionEnabled = byId("fusion-enabled");
const fusionMode = byId("fusion-mode");
const fusionParallel = byId("fusion-parallel");
const fusionParticipants = byId("fusion-participants");
const fusionSynthesis = byId("fusion-synthesis");
const fallbackModels = byId("fallback-models");
const languageSelect = byId("language-select");

function t(key, parameters = {}) {
  return translate(state.locale, key, parameters);
}

function formatTraceTimestamp(value) {
  const timestamp = new Date(value || Date.now());
  const safeTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  return safeTimestamp.toLocaleTimeString(state.locale === "pt" ? "pt-PT" : "en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function parametersFrom(element) {
  const raw = element.dataset.i18nParameters;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function setTranslatedText(element, key, parameters = {}) {
  element.dataset.i18n = key;
  if (Object.keys(parameters).length > 0) element.dataset.i18nParameters = JSON.stringify(parameters);
  else delete element.dataset.i18nParameters;
  element.textContent = t(key, parameters);
}

function applyTranslations() {
  document.documentElement.lang = state.locale === "pt" ? "pt-PT" : "en";
  document.title = t("document.title");
  languageSelect.value = state.locale;
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n, parametersFrom(element));
  }
  for (const attribute of ["aria-label", "alt", "placeholder", "title"]) {
    const dataName = `i18n${attribute
      .split("-")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("")}`;
    for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.dataset[dataName]));
    }
  }
  for (const element of document.querySelectorAll("[data-trace-timestamp]")) {
    element.textContent = formatTraceTimestamp(element.dataset.traceTimestamp);
  }
}

function setLocale(locale, persist = true) {
  state.locale = persist ? persistLocale(window.localStorage, locale) : normalizeLocale(locale);
  applyTranslations();
  renderProjects();
  renderSessions();
  if (state.memoryPayload !== undefined) renderMemory(state.memoryPayload);
  updateTaskState();
}

function statusTranslationKey(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const key = `status.${normalized}`;
  return normalized && translate("en", key) !== key ? key : undefined;
}

function localizeStatus(value) {
  const key = statusTranslationKey(value);
  return key ? t(key) : value;
}

function setStatusText(element, value, fallbackKey) {
  const key = statusTranslationKey(value);
  if (key) setTranslatedText(element, key);
  else if (value) {
    delete element.dataset.i18n;
    delete element.dataset.i18nParameters;
    element.textContent = value;
  } else setTranslatedText(element, fallbackKey);
}

function localizeSessionTitle(value) {
  return isDefaultSessionTitle(value) ? t("sessions.new") : value;
}

function isDefaultSessionTitle(value) {
  return value === translate("en", "sessions.new") || value === translate("pt", "sessions.new");
}

function errorMessage(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = code || message;
  const key = ERROR_KEYS[normalized];
  if (key) return t(key);
  if (normalized.startsWith("invalid_")) {
    const fieldKey = INVALID_FIELD_KEYS[normalized.slice(8)];
    if (fieldKey) return t("error.invalidRequest", { field: t(fieldKey) });
    return message || normalized;
  }
  if (error instanceof TypeError && /fetch|network/iu.test(message)) return t("error.network");
  return message || t("error.internal");
}

function listFrom(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function textFrom(value, keys, fallback = "") {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return fallback;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  return fallback;
}

function idFrom(value, fallback = "") {
  return textFrom(value, ["id", "projectId", "sessionId", "taskId", "value"], fallback);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const code = textFrom(payload, ["error"], `HTTP ${response.status}`);
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return payload;
}

let toastTimer;
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

function makeNavItem(item, kind, selected, onClick) {
  const id = idFrom(item);
  const title = localizeSessionTitle(textFrom(item, ["name", "title", "label"], id || t("common.unnamed")));
  const rawDetail = textFrom(
    item,
    kind === "project" ? ["rootPath", "path", "updatedAt"] : ["updatedAt", "status", "preview"],
    kind === "project" ? t("common.localProject") : t("common.session"),
  );
  const unavailable = kind === "project" && item?.available === false;
  const detail = unavailable ? t("common.folderUnavailable", { detail: rawDetail }) : localizeStatus(rawDetail);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nav-item";
  button.title = kind === "project" ? `${title}\n${detail}` : title;
  button.disabled = unavailable;
  button.setAttribute("aria-current", selected ? "true" : "false");

  const icon = document.createElement("span");
  icon.className = "nav-icon";
  icon.textContent = kind === "project" ? "◆" : "↳";
  const copy = document.createElement("span");
  copy.className = "nav-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = detail;
  copy.append(strong, small);
  button.append(icon, copy);
  button.addEventListener("click", onClick);
  return button;
}

function renderProjects() {
  projectList.replaceChildren();
  for (const project of state.projects) {
    const projectId = idFrom(project);
    projectList.append(makeNavItem(project, "project", projectId === state.projectId, () => void selectProject(projectId)));
  }
  byId("project-count").textContent = String(state.projects.length);
}

function renderSessions() {
  sessionList.replaceChildren();
  for (const session of state.sessions) {
    const sessionId = idFrom(session);
    sessionList.append(makeNavItem(session, "session", sessionId === state.sessionId, () => void selectSession(session)));
  }
  byId("session-count").textContent = String(state.sessions.length);
}

function setSelectOptions(select, items, emptyKey) {
  select.replaceChildren();
  if (items.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    setTranslatedText(option, emptyKey);
    select.append(option);
    return;
  }
  for (const item of items) {
    const option = document.createElement("option");
    option.value = idFrom(item, textFrom(item, ["name", "label"]));
    option.textContent = textFrom(item, ["label", "name", "title"], option.value);
    option.selected = item?.current === true;
    select.append(option);
  }
}

async function loadModels() {
  const provider = providerSelect.value;
  try {
    const payload = await api(`/api/models?provider=${encodeURIComponent(provider)}`);
    state.models = listFrom(payload, ["models", "items"]);
    setSelectOptions(modelSelect, state.models, "common.noModels");
    modelSelect.disabled = state.models.length === 0;
    refreshComposerAvailability();
  } catch (error) {
    state.models = [];
    setSelectOptions(modelSelect, [], "common.unavailable");
    modelSelect.disabled = true;
    refreshComposerAvailability();
    showToast(errorMessage(error), true);
  }
}

function routingOptions(select, models, selected, includeAutomatic = false) {
  const selectedSet = new Set(selected);
  const known = new Set();
  select.replaceChildren();
  if (includeAutomatic) {
    const automatic = document.createElement("option");
    automatic.value = "";
    setTranslatedText(automatic, "routing.automatic");
    automatic.selected = selectedSet.has("");
    select.append(automatic);
  }
  for (const model of models) {
    const selector = idFrom(model, textFrom(model, ["selector", "name", "label"]));
    if (!selector || known.has(selector)) continue;
    known.add(selector);
    const option = document.createElement("option");
    option.value = selector;
    option.textContent = textFrom(model, ["label", "name", "title"], selector);
    option.selected = selectedSet.has(selector);
    select.append(option);
  }
  for (const selector of selectedSet) {
    if (!selector || known.has(selector)) continue;
    const option = document.createElement("option");
    option.value = selector;
    setTranslatedText(option, "routing.unavailable", { selector });
    option.selected = true;
    select.append(option);
  }
}

function selectedRoutingValues(select) {
  return [...select.selectedOptions].map((option) => option.value).filter(Boolean);
}

function updateRoutingAvailability() {
  const enabled = fusionEnabled.checked;
  fusionMode.disabled = !enabled;
  fusionParallel.disabled = !enabled;
  fusionParticipants.disabled = !enabled;
  fusionSynthesis.disabled = !enabled;
}

async function loadRouting() {
  routingForm.setAttribute("aria-busy", "true");
  try {
    const [routing, modelsPayload] = await Promise.all([api("/api/routing"), api("/api/models")]);
    const models = listFrom(modelsPayload, ["models", "items"]);
    const fusion = routing?.fusion || {};
    state.routing = routing;
    fusionEnabled.checked = fusion.enabled === true;
    fusionMode.value = fusion.mode === "moa" ? "moa" : "fusion";
    fusionParallel.value = String(Number.isInteger(fusion.maxParallel) ? fusion.maxParallel : 3);
    routingOptions(fusionParticipants, models, listFrom(fusion, ["models"]));
    routingOptions(fusionSynthesis, models, [textFrom(fusion, ["synthesisModel"])], true);
    routingOptions(fallbackModels, models, listFrom(routing, ["fallbackModels"]));
    updateRoutingAvailability();
  } finally {
    routingForm.removeAttribute("aria-busy");
  }
}

async function openRouting() {
  if (typeof routingDialog.showModal === "function") routingDialog.showModal();
  else routingDialog.setAttribute("open", "");
  try {
    await loadRouting();
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

function closeRouting() {
  if (routingDialog.open && typeof routingDialog.close === "function") routingDialog.close();
  else routingDialog.removeAttribute("open");
}

async function saveRouting() {
  const payload = {
    fallbackModels: selectedRoutingValues(fallbackModels),
    fusion: {
      enabled: fusionEnabled.checked,
      mode: fusionMode.value,
      models: selectedRoutingValues(fusionParticipants),
      synthesisModel: fusionSynthesis.value,
      maxParallel: Number(fusionParallel.value),
    },
  };
  routingForm.setAttribute("aria-busy", "true");
  try {
    state.routing = await api("/api/routing", { method: "POST", body: payload });
    closeRouting();
    showToast(t("toast.routingSaved"));
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    routingForm.removeAttribute("aria-busy");
  }
}

async function selectProject(projectId) {
  state.projectId = projectId || undefined;
  state.sessionId = undefined;
  state.activeTaskId = undefined;
  updateTaskState();
  closeEvents();
  renderProjects();
  const projectLabel = byId("project-label");
  const projectName = textFrom(
    state.projects.find((item) => idFrom(item) === projectId),
    ["name", "title", "label"],
  );
  if (projectName) {
    delete projectLabel.dataset.i18n;
    delete projectLabel.dataset.i18nParameters;
    projectLabel.textContent = projectName.toUpperCase();
  } else setTranslatedText(projectLabel, "workspace.project");
  setTranslatedText(byId("session-title"), "workspace.chooseSession");
  try {
    const payload = await api(`/api/sessions?projectId=${encodeURIComponent(projectId || "")}`);
    state.sessions = listFrom(payload, ["sessions", "items"]);
    renderSessions();
    if (state.sessions[0]) await selectSession(state.sessions[0]);
    else await createSession();
  } catch (error) {
    state.sessions = [];
    renderSessions();
    showToast(errorMessage(error), true);
  }
}

async function selectSession(session) {
  state.sessionId = idFrom(session) || undefined;
  state.activeTaskId = undefined;
  state.traceCount = 0;
  state.streamingMessage = undefined;
  traceList.replaceChildren();
  messages.replaceChildren(emptyState);
  byId("trace-count").textContent = "0";
  const sessionTitle = byId("session-title");
  const rawSessionTitle = textFrom(session, ["title", "name", "label"], "");
  if (!rawSessionTitle || isDefaultSessionTitle(rawSessionTitle)) {
    setTranslatedText(sessionTitle, rawSessionTitle ? "sessions.new" : "common.session");
  } else {
    delete sessionTitle.dataset.i18n;
    delete sessionTitle.dataset.i18nParameters;
    sessionTitle.textContent = rawSessionTitle;
  }
  const preferredModel = textFrom(session, ["preferredModel"]);
  if (preferredModel) {
    const preferredProvider = preferredModel.split("/", 1)[0];
    if ([...providerSelect.options].some((option) => option.value === preferredProvider)) {
      providerSelect.value = preferredProvider;
      await loadModels();
      if ([...modelSelect.options].some((option) => option.value === preferredModel)) modelSelect.value = preferredModel;
    }
  }
  renderSessions();
  updateTaskState();
  openEvents();
  try {
    const payload = await api(`/api/messages?sessionId=${encodeURIComponent(state.sessionId || "")}`);
    const history = listFrom(payload, ["messages", "items"]);
    for (const message of history) appendMessage(textFrom(message, ["role"], "assistant"), textFrom(message, ["content", "text", "message"]));
  } catch (error) {
    showToast(errorMessage(error), true);
  }
  await refreshTasks();
}

async function createSession() {
  if (!state.projectId) return showToast(t("toast.chooseProject"), true);
  try {
    const created = await api("/api/sessions", { method: "POST", body: { projectId: state.projectId, title: "New session" } });
    const payload = await api(`/api/sessions?projectId=${encodeURIComponent(state.projectId)}`);
    state.sessions = listFrom(payload, ["sessions", "items"]);
    renderSessions();
    const selected = state.sessions.find((item) => idFrom(item) === idFrom(created)) || created;
    await selectSession(selected);
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

function appendMessage(role, content) {
  if (emptyState?.isConnected) emptyState.remove();
  const article = document.createElement("article");
  article.className = `message ${role === "user" ? "user" : "assistant"}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  setTranslatedText(avatar, role === "user" ? "common.youAvatar" : "common.aiAvatar");
  const body = document.createElement("div");
  body.className = "message-body";
  const author = document.createElement("strong");
  if (role === "user") setTranslatedText(author, "common.you");
  else author.textContent = "Axiomux";
  const paragraph = document.createElement("p");
  paragraph.textContent = content;
  body.append(author, paragraph);
  article.append(avatar, body);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  return paragraph;
}

function appendTrace(event) {
  const titleDescriptor = traceTitleDescriptor(event);
  const rawTitle = textFrom(event, ["label", "title", "kind", "type"], t("trace.activity"));
  const summaryKey = textFrom(event, ["summaryKey"]);
  const rawSummary = textFrom(event, ["summary", "message", "status", "detail"], "");
  const detailDescriptor = summaryKey ? { key: summaryKey, parameters: {} } : traceDetailDescriptor(event, rawSummary);
  const statusKey = detailDescriptor ? undefined : statusTranslationKey(rawSummary);
  const summary = detailDescriptor ? t(detailDescriptor.key, detailDescriptor.parameters) : statusKey ? t(statusKey) : rawSummary;
  const item = document.createElement("li");
  item.className = "trace-item";
  const strong = document.createElement("strong");
  if (titleDescriptor) setTranslatedText(strong, titleDescriptor.key, titleDescriptor.parameters);
  else strong.textContent = rawTitle.replaceAll("_", " ");
  item.append(strong);
  const title = titleDescriptor ? t(titleDescriptor.key, titleDescriptor.parameters) : rawTitle;
  if (summary && summary !== title) {
    const summaryNode = document.createElement("span");
    if (detailDescriptor) setTranslatedText(summaryNode, detailDescriptor.key, detailDescriptor.parameters);
    else if (statusKey) setTranslatedText(summaryNode, statusKey);
    else summaryNode.textContent = summary;
    item.append(summaryNode);
  }
  const time = document.createElement("time");
  const eventTimestamp = textFrom(event, ["at", "timestamp"]);
  const parsedTimestamp = new Date(eventTimestamp || Date.now());
  time.dataset.traceTimestamp = Number.isNaN(parsedTimestamp.getTime()) ? new Date().toISOString() : parsedTimestamp.toISOString();
  time.textContent = formatTraceTimestamp(time.dataset.traceTimestamp);
  item.append(time);
  traceList.append(item);
  state.traceCount += 1;
  byId("trace-count").textContent = String(state.traceCount);
  traceList.scrollTop = traceList.scrollHeight;
}

function handleEvent(event) {
  const type = textFrom(event, ["type", "kind", "event"], "event");
  if (type === "ready") return;

  if (type === "approval.requested") {
    const id = idFrom(event);
    if (id && state.activeApproval?.id !== id && !state.approvalQueue.some((item) => idFrom(item) === id)) {
      state.approvalQueue.push(event);
    }
    showNextApproval();
    appendTrace({ type, summaryKey: "trace.approvalWaiting" });
    return;
  }
  if (type === "approval.resolved") {
    const id = idFrom(event);
    state.approvalQueue = state.approvalQueue.filter((item) => idFrom(item) !== id);
    if (state.activeApproval?.id === id) closeApproval();
    appendTrace({ type, summaryKey: event.approved ? "trace.approvalAllowed" : "trace.approvalDenied" });
    showNextApproval();
    return;
  }

  if (type === "assistant.delta") {
    const delta = textFrom(event, ["delta", "content", "text"]);
    if (!state.streamingMessage) state.streamingMessage = appendMessage("assistant", "");
    state.streamingMessage.textContent += delta;
    messages.scrollTop = messages.scrollHeight;
    return;
  }
  if (type === "assistant.message" || type === "task.completed") {
    const content = textFrom(event, ["content", "message", "result"]);
    if (content && !state.streamingMessage) appendMessage("assistant", content);
    state.streamingMessage = undefined;
    if (type === "task.completed") state.activeTaskId = undefined;
    updateTaskState();
    appendTrace(event);
    return;
  }
  if (type === "task.started" || type === "task.running" || type === "task.update") {
    state.activeTaskId = textFrom(event, ["taskId", "id"], state.activeTaskId);
    const status = textFrom(event, ["summary", "status", "message"]);
    setStatusText(taskStatus, status, "task.working");
    updateTaskState();
    appendTrace(event);
    return;
  }
  if (type === "task.failed" || type === "task.stopped" || type === "task.cancelled") {
    state.activeTaskId = undefined;
    updateTaskState();
    appendTrace(event);
    return;
  }
  appendTrace(event);
}

function showNextApproval() {
  if (state.activeApproval || state.approvalQueue.length === 0) return;
  const request = state.approvalQueue.shift();
  state.activeApproval = { id: idFrom(request), taskId: textFrom(request, ["taskId"]), request };
  const description = textFrom(request, ["description", "summary"]);
  if (description) {
    delete approvalDescription.dataset.i18n;
    delete approvalDescription.dataset.i18nParameters;
    approvalDescription.textContent = description;
  } else setTranslatedText(approvalDescription, "approval.noDescription");
  if (typeof approvalDialog.showModal === "function") approvalDialog.showModal();
  else approvalDialog.setAttribute("open", "");
  byId("approval-deny").focus();
}

function closeApproval() {
  state.activeApproval = undefined;
  if (approvalDialog.open && typeof approvalDialog.close === "function") approvalDialog.close();
  else approvalDialog.removeAttribute("open");
}

async function decideApproval(approved) {
  const current = state.activeApproval;
  if (!current) return;
  byId("approval-deny").disabled = true;
  byId("approval-allow").disabled = true;
  try {
    await api("/api/approval", { method: "POST", body: { id: current.id, approved } });
    closeApproval();
    showNextApproval();
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    byId("approval-deny").disabled = false;
    byId("approval-allow").disabled = false;
  }
}

function closeEvents() {
  if (state.events) state.events.close();
  state.events = undefined;
}

function openEvents() {
  closeEvents();
  if (!state.sessionId) return;
  const params = new URLSearchParams({ sessionId: state.sessionId });
  if (state.projectId) params.set("projectId", state.projectId);
  const source = new EventSource(`/api/events?${params.toString()}`);
  source.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      showToast(t("toast.invalidEvent"), true);
    }
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) showToast(t("toast.activityDisconnected"), true);
  };
  state.events = source;
}

function updateTaskState() {
  const running = Boolean(state.activeTaskId);
  activeTask.hidden = !running;
  setTranslatedText(sendLabel, running ? "composer.steer" : "composer.run");
  setTranslatedText(byId("composer-hint"), running ? "composer.steeringHint" : "composer.hint");
  messageInput.dataset.i18nPlaceholder = running ? "composer.steeringPlaceholder" : "composer.placeholder";
  messageInput.placeholder = t(messageInput.dataset.i18nPlaceholder);
  refreshComposerAvailability();
}

function refreshComposerAvailability() {
  sendButton.disabled = !state.activeTaskId && !modelSelect.value;
}

async function refreshTasks() {
  if (!state.sessionId) return;
  try {
    const payload = await api(`/api/tasks?sessionId=${encodeURIComponent(state.sessionId)}`);
    const tasks = listFrom(payload, ["tasks", "items"]);
    const running = tasks.find((task) => ["queued", "running", "active", "waiting"].includes(textFrom(task, ["status"]).toLowerCase()));
    state.activeTaskId = running ? idFrom(running) : undefined;
    if (running) {
      const status = textFrom(running, ["summary", "status"]);
      setStatusText(taskStatus, status, "task.working");
    }
    updateTaskState();
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function submitMessage() {
  const message = messageInput.value.trim();
  if (!message) return;
  if (!state.sessionId) {
    showToast(t("toast.chooseSession"), true);
    return;
  }
  if (!state.activeTaskId && !modelSelect.value) {
    showToast(t("toast.noChatModel"), true);
    return;
  }
  sendButton.disabled = true;
  try {
    if (state.activeTaskId) {
      await api("/api/steer", { method: "POST", body: { taskId: state.activeTaskId, message } });
      const guidance = appendMessage("user", t("message.guidance", { message }));
      setTranslatedText(guidance, "message.guidance", { message });
      appendTrace({ type: "steering.queued", summaryKey: "trace.guidanceSent" });
    } else {
      appendMessage("user", message);
      const payload = await api("/api/chat", {
        method: "POST",
        body: {
          sessionId: state.sessionId,
          message,
          provider: providerSelect.value || undefined,
          model: modelSelect.value || undefined,
          responseLanguage: state.locale,
        },
      });
      state.activeTaskId = textFrom(payload, ["taskId", "id"], "") || undefined;
      const immediate = textFrom(payload, ["content", "message", "result"]);
      if (immediate) appendMessage("assistant", immediate);
      if (state.activeTaskId) {
        const status = textFrom(payload, ["status", "summary"]);
        setStatusText(taskStatus, status, "task.starting");
      }
      updateTaskState();
    }
    messageInput.value = "";
    messageInput.focus();
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    refreshComposerAvailability();
  }
}

function setMemoryOpen(open) {
  memoryDrawer.classList.toggle("open", open);
  memoryDrawer.setAttribute("aria-hidden", open ? "false" : "true");
  drawerBackdrop.hidden = !open;
  if (open) byId("memory-query").focus();
}

function renderMemory(payload) {
  state.memoryPayload = payload;
  const container = byId("memory-results");
  const results = listFrom(payload, ["results", "items", "memories", "messages"]);
  container.replaceChildren();
  if (results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    setTranslatedText(empty, "memory.noResults");
    container.append(empty);
    return;
  }
  for (const result of results) {
    const card = document.createElement("article");
    card.className = "memory-card";
    const kind = document.createElement("strong");
    const rawKind = textFrom(result, ["kind", "type", "role"]);
    const kindKey = MEMORY_KIND_KEYS[rawKind.trim().toLowerCase()];
    if (kindKey) setTranslatedText(kind, kindKey);
    else if (rawKind) kind.textContent = rawKind.toUpperCase();
    else setTranslatedText(kind, "memory.kind");
    const content = document.createElement("p");
    const preview = textFrom(result, ["content", "text", "summary", "message"]);
    if (preview) content.textContent = preview;
    else setTranslatedText(content, "memory.noPreview");
    const source = document.createElement("small");
    const provenance = textFrom(result, ["sourceUri", "source", "sessionTitle", "createdAt", "timestamp"], t("memory.localContext"));
    const rawReview = textFrom(result, ["reviewStatus"], "");
    const reviewKey = MEMORY_REVIEW_KEYS[rawReview.trim().toLowerCase()];
    const review = reviewKey ? t(reviewKey) : rawReview;
    const confidence = typeof result?.confidence === "number" ? t("memory.confidence", { value: result.confidence.toFixed(2) }) : "";
    source.textContent = [provenance, review, confidence].filter(Boolean).join(" · ");
    card.append(kind, content, source);
    container.append(card);
  }
}

async function searchMemory() {
  const params = new URLSearchParams({ q: byId("memory-query").value.trim() });
  if (!byId("search-all-projects").checked) {
    if (state.projectId) params.set("projectId", state.projectId);
    if (state.sessionId) params.set("sessionId", state.sessionId);
  }
  try {
    renderMemory(await api(`/api/search?${params.toString()}`));
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function initialize() {
  try {
    const [projectsPayload, providersPayload] = await Promise.all([api("/api/projects"), api("/api/providers")]);
    state.projects = listFrom(projectsPayload, ["projects", "items"]);
    state.providers = listFrom(providersPayload, ["providers", "items"]);
    renderProjects();
    setSelectOptions(providerSelect, state.providers, "common.automatic");
    await loadModels();
    const initialProject = state.projects.find((item) => item?.current === true) || state.projects[0];
    if (initialProject) await selectProject(idFrom(initialProject));
  } catch (error) {
    showToast(t("toast.initializeFailed", { message: errorMessage(error) }), true);
  }
}

byId("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitMessage();
  }
});
providerSelect.addEventListener("change", () => void loadModels());
languageSelect.addEventListener("change", () => setLocale(languageSelect.value));
byId("stop-button").addEventListener("click", async () => {
  if (!state.activeTaskId) return;
  try {
    await api("/api/stop", { method: "POST", body: { taskId: state.activeTaskId } });
    setTranslatedText(taskStatus, "task.stopping");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
});
byId("memory-open").addEventListener("click", () => setMemoryOpen(true));
byId("routing-open").addEventListener("click", () => void openRouting());
byId("routing-close").addEventListener("click", closeRouting);
byId("routing-cancel").addEventListener("click", closeRouting);
fusionEnabled.addEventListener("change", updateRoutingAvailability);
routingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveRouting();
});
routingDialog.addEventListener("cancel", closeRouting);
byId("approval-deny").addEventListener("click", () => void decideApproval(false));
byId("approval-allow").addEventListener("click", () => void decideApproval(true));
approvalDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  void decideApproval(false);
});
byId("new-session").addEventListener("click", () => void createSession());
byId("memory-close").addEventListener("click", () => setMemoryOpen(false));
drawerBackdrop.addEventListener("click", () => setMemoryOpen(false));
byId("memory-search").addEventListener("submit", (event) => {
  event.preventDefault();
  void searchMemory();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMemoryOpen(false);
});
window.addEventListener("beforeunload", closeEvents);

applyTranslations();
void initialize();
