export const DEFAULT_LOCALE = "en";
export const LOCALE_STORAGE_KEY = "superai.ui.locale";
export const SUPPORTED_LOCALES = Object.freeze(["en", "pt"]);

export const EVENT_TITLE_KEYS = Object.freeze({
  "approval.requested": "trace.approvalRequested",
  "approval.resolved": "trace.approvalResolved",
  "assistant.message": "trace.assistantMessage",
  "reasoning.activity": "trace.reasoningActivity",
  "steering.queued": "trace.steeringQueued",
  "subscription.error": "trace.subscriptionError",
  "task.cancelled": "trace.taskCancelled",
  "task.completed": "trace.taskCompleted",
  "task.failed": "trace.taskFailed",
  "task.running": "trace.taskRunning",
  "task.started": "trace.taskStarted",
  "task.stopped": "trace.taskStopped",
  "task.update": "trace.taskUpdated",
});

export const STABLE_TRACE_LABEL_KEYS = Object.freeze({
  "Active run interrupted by explicit user request": "trace.activeRunInterrupted",
  "Follow-up queued after the active run": "trace.followUpQueued",
  "Fusion skipped for exact model route": "trace.fusionSkippedExactRoute",
  "Governed memory recalled": "trace.governedMemoryRecalled",
  "Host tool cancelled by OMP": "trace.hostToolCancelled",
  "Local episodic summary stored for review": "trace.episodicSummaryStored",
  "Multi-model advisory panel completed": "trace.advisoryPanelCompleted",
  "Multi-model advisory panel unavailable; principal agent continues": "trace.advisoryPanelUnavailable",
  "Operational self-evaluation stored for review": "trace.selfEvaluationStored",
  "Provider attempt completed": "trace.providerAttemptCompleted",
  "Provider attempt failed": "trace.providerAttemptFailed",
  "Provider attempt failed before startup": "trace.providerAttemptFailedBeforeStartup",
  "Provider attempt started": "trace.providerAttemptStarted",
  "Provider circuit is temporarily open": "trace.providerCircuitOpen",
  "Provider reasoning completed": "trace.providerReasoningCompleted",
  "Provider reasoning in progress": "trace.providerReasoningProgress",
  "Provider reasoning started": "trace.providerReasoningStarted",
  "Queued user update could not be delivered": "trace.queuedUpdateDeliveryFailed",
  "Turn cancelled": "trace.turnCancelled",
  "Turn completed": "trace.turnCompleted",
  "Turn failed": "trace.turnFailed",
  "Turn started": "trace.turnStarted",
  "User update delivered to the active model": "trace.userUpdateDelivered",
  "User update steered into the active run": "trace.userUpdateSteered",
  "User update will be included before the model starts": "trace.userUpdateDeferred",
});

export const FUSION_TRACE_TITLE_KEYS = Object.freeze({
  "consultant.completed": "trace.fusionConsultantCompleted",
  "consultant.failed": "trace.fusionConsultantFailed",
  "consultant.queued": "trace.fusionConsultantQueued",
  "consultant.started": "trace.fusionConsultantStarted",
  "run.completed": "trace.fusionRunCompleted",
  "run.failed": "trace.fusionRunFailed",
  "run.queued": "trace.fusionRunQueued",
  "run.started": "trace.fusionRunStarted",
  "synthesis.completed": "trace.fusionSynthesisCompleted",
  "synthesis.failed": "trace.fusionSynthesisFailed",
  "synthesis.queued": "trace.fusionSynthesisQueued",
  "synthesis.started": "trace.fusionSynthesisStarted",
});

export const FUSION_REASON_DETAIL_KEYS = Object.freeze({
  empty_output: "trace.detailFusionEmptyOutput",
  no_candidates: "trace.detailFusionNoCandidates",
  runner_error: "trace.detailFusionRunnerError",
  timeout: "trace.detailFusionTimeout",
});

export const ERROR_KEYS = Object.freeze({
  authentication_required: "error.authenticationRequired",
  body_too_large: "error.bodyTooLarge",
  capability_unavailable: "error.capabilityUnavailable",
  cross_site_rejected: "error.crossSiteRejected",
  internal_error: "error.internal",
  invalid_host: "error.invalidHost",
  invalid_json: "error.invalidJson",
  invalid_origin: "error.invalidOrigin",
  invalid_response_language: "error.invalidResponseLanguage",
  json_required: "error.jsonRequired",
  loopback_only: "error.loopbackOnly",
  method_not_allowed: "error.methodNotAllowed",
  not_found: "error.notFound",
  object_required: "error.objectRequired",
  origin_required: "error.originRequired",
  proxy_headers_rejected: "error.proxyHeadersRejected",
  request_failed: "error.requestFailed",
  response_too_large: "error.responseTooLarge",
  shutting_down: "error.shuttingDown",
  starting: "error.starting",
  ui_asset_missing: "error.uiAssetMissing",
});

export const INVALID_FIELD_KEYS = Object.freeze({
  approval_id: "field.approvalId",
  approved: "field.approvalDecision",
  fallback_models: "field.fallbackModels",
  fusion: "field.fusion",
  fusion_enabled: "field.fusionEnabled",
  fusion_mode: "field.fusionMode",
  fusion_models: "field.fusionModels",
  max_parallel: "field.maxParallel",
  message: "field.message",
  model: "field.model",
  project_id: "field.projectId",
  provider: "field.provider",
  query: "field.query",
  session_id: "field.sessionId",
  synthesis_model: "field.synthesisModel",
  task_id: "field.taskId",
  title: "field.title",
});

export const MEMORY_KIND_KEYS = Object.freeze({
  evidence: "memory.kindEvidence",
  instruction: "memory.kindInstruction",
  preference: "memory.kindPreference",
  procedure: "memory.kindProcedure",
});

export const MEMORY_REVIEW_KEYS = Object.freeze({
  approved: "memory.reviewApproved",
  pending: "memory.reviewPending",
  rejected: "memory.reviewRejected",
});

export const translations = Object.freeze({
  en: Object.freeze({
    "document.title": "Axiomux",
    "language.label": "Language",
    "language.aria": "Interface and response language",
    "language.title": "Change the interface and assistant response language",
    "language.english": "English",
    "language.portuguese": "Português",
    "sidebar.aria": "Projects and sessions",
    "brand.subtitle": "local agent workspace",
    "projects.title": "Projects",
    "projects.aria": "Projects",
    "sessions.title": "Sessions",
    "sessions.aria": "Sessions",
    "sessions.new": "New session",
    "status.localExecution": "Local execution",
    "status.privateConnection": "Private connection",
    "workspace.project": "PROJECT",
    "workspace.chooseSession": "Choose a session",
    "controls.provider": "Provider",
    "controls.providerAria": "Provider",
    "controls.model": "Model",
    "controls.modelAria": "Model",
    "controls.routing": "Routing",
    "controls.routingTitle": "Configure fallback and Fusion/MoA",
    "controls.memory": "Memory",
    "controls.memoryTitle": "Open memory",
    "conversation.aria": "Conversation",
    "empty.emblemAlt": "Axiomux emblem",
    "empty.eyebrow": "AXIOMUX WORKSPACE",
    "empty.title": "One agent, multiple minds.",
    "empty.description": "Select a session and describe the outcome you want. You can steer the work while it is running.",
    "task.working": "Working",
    "task.starting": "Starting",
    "task.stopping": "Stopping",
    "task.stop": "Stop",
    "composer.label": "Message or guidance",
    "composer.placeholder": "Tell Axiomux what you want to build…",
    "composer.steeringPlaceholder": "Add context or change direction without stopping the task…",
    "composer.hint": "Enter to send · Shift+Enter for a new line",
    "composer.steeringHint": "Your message steers the task without interrupting it",
    "composer.run": "Run",
    "composer.steer": "Steer",
    "trace.aria": "Public agent activity",
    "trace.eyebrow": "ACTIVITY",
    "trace.title": "Public trace",
    "trace.note": "Plans, tools and evidence. The model's private reasoning is never shown.",
    "trace.activity": "Activity",
    "trace.approvalRequested": "Approval requested",
    "trace.approvalResolved": "Approval resolved",
    "trace.assistantMessage": "Assistant response",
    "trace.taskStarted": "Task started",
    "trace.taskRunning": "Task running",
    "trace.taskUpdated": "Task updated",
    "trace.taskCompleted": "Task completed",
    "trace.taskFailed": "Task failed",
    "trace.taskStopped": "Task stopped",
    "trace.taskCancelled": "Task cancelled",
    "trace.steeringQueued": "Guidance queued",
    "trace.reasoningActivity": "Provider reasoning activity",
    "trace.subscriptionError": "Activity subscription failed",
    "trace.turnStarted": "Turn started",
    "trace.governedMemoryRecalled": "Governed memory recalled",
    "trace.userUpdateDelivered": "User update delivered to the active model",
    "trace.userUpdateDeferred": "User update will be included before the model starts",
    "trace.fusionSkippedExactRoute": "Fusion skipped for exact model route",
    "trace.advisoryPanelCompleted": "Multi-model advisory panel completed",
    "trace.advisoryPanelUnavailable": "Multi-model advisory panel unavailable; principal agent continues",
    "trace.providerCircuitOpen": "Provider circuit is temporarily open",
    "trace.providerAttemptFailedBeforeStartup": "Provider attempt failed before startup",
    "trace.providerAttemptStarted": "Provider attempt started",
    "trace.providerAttemptCompleted": "Provider attempt completed",
    "trace.selfEvaluationStored": "Operational self-evaluation stored for review",
    "trace.episodicSummaryStored": "Local episodic summary stored for review",
    "trace.turnCompleted": "Turn completed",
    "trace.providerAttemptFailed": "Provider attempt failed",
    "trace.turnCancelled": "Turn cancelled",
    "trace.turnFailed": "Turn failed",
    "trace.userUpdateSteered": "User update steered into the active run",
    "trace.followUpQueued": "Follow-up queued after the active run",
    "trace.activeRunInterrupted": "Active run interrupted by explicit user request",
    "trace.providerReasoningStarted": "Provider reasoning started",
    "trace.providerReasoningProgress": "Provider reasoning in progress",
    "trace.providerReasoningCompleted": "Provider reasoning completed",
    "trace.hostToolCancelled": "Host tool cancelled by OMP",
    "trace.queuedUpdateDeliveryFailed": "Queued user update could not be delivered",
    "trace.toolNamed": "Tool {name}",
    "trace.fusionConsultantQueued": "Fusion consultant {index} queued",
    "trace.fusionConsultantStarted": "Fusion consultant {index} started",
    "trace.fusionConsultantCompleted": "Fusion consultant {index} completed",
    "trace.fusionConsultantFailed": "Fusion consultant {index} failed",
    "trace.fusionSynthesisQueued": "Fusion synthesis queued",
    "trace.fusionSynthesisStarted": "Fusion synthesis started",
    "trace.fusionSynthesisCompleted": "Fusion synthesis completed",
    "trace.fusionSynthesisFailed": "Fusion synthesis failed",
    "trace.fusionRunQueued": "Fusion run queued",
    "trace.fusionRunStarted": "Fusion run started",
    "trace.fusionRunCompleted": "Fusion run completed",
    "trace.fusionRunFailed": "Fusion run failed",
    "trace.approvalWaiting": "Execution is waiting for an explicit human decision.",
    "trace.approvalAllowed": "Action approved once.",
    "trace.approvalDenied": "Action denied or expired.",
    "trace.guidanceSent": "New guidance sent to the active task.",
    "trace.detailTurnSession": "session={session}",
    "trace.detailTurnWorkflow": "session={session}; workflow key={workflowKey}",
    "trace.detailMemoryItems": "{count} memory item(s): {items}",
    "trace.detailMemoryNone": "{count} memory item(s): none",
    "trace.detailExactRoute": "model={model}; no consultant received the prompt",
    "trace.detailAdvisoryPanel": "{usable}/{total} usable consultant answer(s); mode={mode}",
    "trace.detailToolCalls": "{count} tool call(s)",
    "trace.detailReasoningProcessed": "{count} private reasoning characters processed",
    "trace.detailReasoningNotPersisted": "{count} private reasoning characters processed; content not persisted",
    "trace.detailFallbackAllowed": "{detail}; fallback is allowed",
    "trace.detailFallbackBlocked": "{detail}; fallback blocked by the side-effect ledger",
    "trace.detailFusionDuration": "{duration} ms",
    "trace.detailFusionEmptyOutput": "{duration} ms; empty output",
    "trace.detailFusionNoCandidates": "{duration} ms; no usable candidates",
    "trace.detailFusionRunnerError": "{duration} ms; runner error",
    "trace.detailFusionTimeout": "{duration} ms; timed out",
    "memory.aria": "Searchable memory",
    "memory.context": "CONTEXT",
    "memory.title": "Memory",
    "memory.close": "Close memory",
    "memory.searchLabel": "Search decisions, facts and sessions",
    "memory.searchPlaceholder": "Example: security decisions",
    "memory.searchButton": "Search",
    "memory.allProjects": "All projects and sessions",
    "memory.scopeNote": "Sessions respect the current selection. Governed memory uses its configured scope and may span projects.",
    "memory.noResults": "No results for this search.",
    "memory.kind": "MEMORY",
    "memory.noPreview": "Record has no preview",
    "memory.localContext": "Local context",
    "memory.confidence": "confidence {value}",
    "memory.kindEvidence": "EVIDENCE",
    "memory.kindInstruction": "INSTRUCTION",
    "memory.kindPreference": "PREFERENCE",
    "memory.kindProcedure": "PROCEDURE",
    "memory.reviewPending": "Pending review",
    "memory.reviewApproved": "Approved",
    "memory.reviewRejected": "Rejected",
    "routing.eyebrow": "ORCHESTRATION",
    "routing.title": "Fallback and Fusion/MoA",
    "routing.close": "Close routing settings",
    "routing.note":
      "Global routes may send the request to the selected providers. An explicit model choice for a session or request remains exact: it does not enable fallback or Fusion.",
    "routing.enable": "Enable multi-model council",
    "routing.enableHelp": "Participants have no tools; the synthesizer receives their responses only as untrusted data.",
    "routing.mode": "Mode",
    "routing.modeFusion": "Fusion — final synthesis",
    "routing.modeMoa": "MoA — advisory panel",
    "routing.maxParallel": "Maximum concurrency",
    "routing.participants": "Participants (2–8 when enabled)",
    "routing.participantsHelp": "Ctrl/Cmd + click combines models from any provider, including Neuralwatt.",
    "routing.synthesizer": "Synthesizer/judge",
    "routing.fallback": "Global fallback (0–8, in the displayed order)",
    "routing.fallbackHelp": "Empty by default. It is attempted only while retrying remains safe and no consequential effect has completed.",
    "routing.cancel": "Cancel",
    "routing.save": "Save routing",
    "routing.automatic": "Automatic — use the primary model",
    "routing.unavailable": "Unavailable — {selector}",
    "approval.eyebrow": "HUMAN CONFIRMATION",
    "approval.title": "Authorize an action with effects?",
    "approval.note": "Read the full request. Approve only if you recognize the intent and destination.",
    "approval.deny": "Deny",
    "approval.allowOnce": "Approve once",
    "approval.noDescription": "The request has no description; deny it for safety.",
    "common.unnamed": "Unnamed",
    "common.localProject": "Local project",
    "common.session": "Session",
    "common.folderUnavailable": "Folder unavailable · {detail}",
    "common.noModels": "No models — sign in or configure a provider",
    "common.unavailable": "Unavailable",
    "common.automatic": "Automatic",
    "common.you": "You",
    "common.youAvatar": "YOU",
    "common.aiAvatar": "AI",
    "status.queued": "Queued",
    "status.running": "Running",
    "status.active": "Active",
    "status.waiting": "Waiting",
    "status.completed": "Completed",
    "status.failed": "Failed",
    "status.stopped": "Stopped",
    "status.cancelled": "Cancelled",
    "status.pending": "Pending",
    "status.reviewed": "Reviewed",
    "status.dismissed": "Dismissed",
    "toast.routingSaved": "Routing saved. Explicit routes remain exact.",
    "toast.chooseProject": "Choose a project first.",
    "toast.chooseSession": "Choose a session first.",
    "toast.noChatModel": "This provider has no chat model available. Sign in or choose another provider.",
    "toast.invalidEvent": "An invalid event was ignored.",
    "toast.activityDisconnected": "The activity channel was interrupted.",
    "toast.initializeFailed": "Startup failed: {message}",
    "message.guidance": "Guidance: {message}",
    "field.projectId": "project ID",
    "field.sessionId": "session ID",
    "field.taskId": "task ID",
    "field.approvalId": "approval ID",
    "field.query": "search query",
    "field.provider": "provider",
    "field.title": "session title",
    "field.message": "message",
    "field.model": "model",
    "field.approvalDecision": "approval decision",
    "field.fusion": "Fusion configuration",
    "field.fusionMode": "Fusion mode",
    "field.fallbackModels": "fallback models",
    "field.fusionEnabled": "Fusion enabled flag",
    "field.fusionModels": "Fusion models",
    "field.synthesisModel": "synthesis model",
    "field.maxParallel": "maximum concurrency",
    "error.authenticationRequired": "Authentication is required.",
    "error.capabilityUnavailable": "This capability is unavailable.",
    "error.invalidHost": "The request used an invalid host.",
    "error.loopbackOnly": "The UI is available only on this computer.",
    "error.proxyHeadersRejected": "Proxy headers are not accepted by the local UI.",
    "error.invalidOrigin": "The request came from an invalid origin.",
    "error.crossSiteRejected": "A cross-site request was rejected.",
    "error.originRequired": "A same-origin request is required.",
    "error.jsonRequired": "The request must use JSON.",
    "error.bodyTooLarge": "The request body is too large.",
    "error.invalidJson": "The request contains invalid JSON.",
    "error.objectRequired": "The request body must be an object.",
    "error.invalidRequest": "The request contains an invalid value: {field}.",
    "error.invalidResponseLanguage": "The response language must be English or Portuguese.",
    "error.methodNotAllowed": "This request method is not allowed.",
    "error.notFound": "The requested resource was not found.",
    "error.uiAssetMissing": "A required UI asset is missing.",
    "error.shuttingDown": "The local UI is shutting down.",
    "error.responseTooLarge": "The response is too large to display safely.",
    "error.starting": "The local UI is still starting.",
    "error.requestFailed": "The local request could not be completed.",
    "error.internal": "An internal error occurred.",
    "error.network": "The local UI could not be reached.",
  }),
  pt: Object.freeze({
    "document.title": "Axiomux",
    "language.label": "Idioma",
    "language.aria": "Idioma da interface e das respostas",
    "language.title": "Alterar o idioma da interface e das respostas do assistente",
    "language.english": "English",
    "language.portuguese": "Português",
    "sidebar.aria": "Projetos e sessões",
    "brand.subtitle": "espaço de trabalho do agente local",
    "projects.title": "Projetos",
    "projects.aria": "Projetos",
    "sessions.title": "Sessões",
    "sessions.aria": "Sessões",
    "sessions.new": "Nova sessão",
    "status.localExecution": "Execução local",
    "status.privateConnection": "Ligação privada",
    "workspace.project": "PROJETO",
    "workspace.chooseSession": "Escolhe uma sessão",
    "controls.provider": "Provider",
    "controls.providerAria": "Provider",
    "controls.model": "Modelo",
    "controls.modelAria": "Modelo",
    "controls.routing": "Routing",
    "controls.routingTitle": "Configurar fallback e Fusion/MoA",
    "controls.memory": "Memória",
    "controls.memoryTitle": "Abrir memória",
    "conversation.aria": "Conversa",
    "empty.emblemAlt": "Emblema Axiomux",
    "empty.eyebrow": "ESPAÇO AXIOMUX",
    "empty.title": "Um agente, várias mentes.",
    "empty.description": "Seleciona uma sessão e descreve o resultado que queres. Podes orientar o trabalho enquanto está a decorrer.",
    "task.working": "A trabalhar",
    "task.starting": "A iniciar",
    "task.stopping": "A parar",
    "task.stop": "Parar",
    "composer.label": "Mensagem ou orientação",
    "composer.placeholder": "Diz ao Axiomux o que queres construir…",
    "composer.steeringPlaceholder": "Acrescenta contexto ou muda a direção sem parar a tarefa…",
    "composer.hint": "Enter para enviar · Shift+Enter para nova linha",
    "composer.steeringHint": "A tua mensagem orienta a tarefa sem a interromper",
    "composer.run": "Executar",
    "composer.steer": "Orientar",
    "trace.aria": "Atividade pública do agente",
    "trace.eyebrow": "ATIVIDADE",
    "trace.title": "Trace pública",
    "trace.note": "Planos, ferramentas e evidência. O raciocínio privado do modelo nunca é apresentado.",
    "trace.activity": "Atividade",
    "trace.approvalRequested": "Aprovação pedida",
    "trace.approvalResolved": "Aprovação resolvida",
    "trace.assistantMessage": "Resposta do assistente",
    "trace.taskStarted": "Tarefa iniciada",
    "trace.taskRunning": "Tarefa em execução",
    "trace.taskUpdated": "Tarefa atualizada",
    "trace.taskCompleted": "Tarefa concluída",
    "trace.taskFailed": "Tarefa falhou",
    "trace.taskStopped": "Tarefa parada",
    "trace.taskCancelled": "Tarefa cancelada",
    "trace.steeringQueued": "Orientação em fila",
    "trace.reasoningActivity": "Atividade de raciocínio do provider",
    "trace.subscriptionError": "Falha na subscrição da atividade",
    "trace.turnStarted": "Turno iniciado",
    "trace.governedMemoryRecalled": "Memória governada recuperada",
    "trace.userUpdateDelivered": "Atualização do utilizador entregue ao modelo ativo",
    "trace.userUpdateDeferred": "A atualização do utilizador será incluída antes de o modelo iniciar",
    "trace.fusionSkippedExactRoute": "Fusion ignorado para uma rota de modelo exata",
    "trace.advisoryPanelCompleted": "Painel consultivo multi-modelo concluído",
    "trace.advisoryPanelUnavailable": "Painel consultivo multi-modelo indisponível; o agente principal continua",
    "trace.providerCircuitOpen": "O circuito do provider está temporariamente aberto",
    "trace.providerAttemptFailedBeforeStartup": "A tentativa do provider falhou antes do arranque",
    "trace.providerAttemptStarted": "Tentativa do provider iniciada",
    "trace.providerAttemptCompleted": "Tentativa do provider concluída",
    "trace.selfEvaluationStored": "Autoavaliação operacional guardada para revisão",
    "trace.episodicSummaryStored": "Resumo episódico local guardado para revisão",
    "trace.turnCompleted": "Turno concluído",
    "trace.providerAttemptFailed": "A tentativa do provider falhou",
    "trace.turnCancelled": "Turno cancelado",
    "trace.turnFailed": "O turno falhou",
    "trace.userUpdateSteered": "Atualização do utilizador introduzida na execução ativa",
    "trace.followUpQueued": "Seguimento colocado em fila após a execução ativa",
    "trace.activeRunInterrupted": "Execução ativa interrompida por pedido explícito do utilizador",
    "trace.providerReasoningStarted": "Raciocínio do provider iniciado",
    "trace.providerReasoningProgress": "Raciocínio do provider em curso",
    "trace.providerReasoningCompleted": "Raciocínio do provider concluído",
    "trace.hostToolCancelled": "Ferramenta do host cancelada pelo OMP",
    "trace.queuedUpdateDeliveryFailed": "Não foi possível entregar a atualização do utilizador em fila",
    "trace.toolNamed": "Ferramenta {name}",
    "trace.fusionConsultantQueued": "Consultor Fusion {index} em fila",
    "trace.fusionConsultantStarted": "Consultor Fusion {index} iniciado",
    "trace.fusionConsultantCompleted": "Consultor Fusion {index} concluído",
    "trace.fusionConsultantFailed": "O consultor Fusion {index} falhou",
    "trace.fusionSynthesisQueued": "Síntese Fusion em fila",
    "trace.fusionSynthesisStarted": "Síntese Fusion iniciada",
    "trace.fusionSynthesisCompleted": "Síntese Fusion concluída",
    "trace.fusionSynthesisFailed": "A síntese Fusion falhou",
    "trace.fusionRunQueued": "Execução Fusion em fila",
    "trace.fusionRunStarted": "Execução Fusion iniciada",
    "trace.fusionRunCompleted": "Execução Fusion concluída",
    "trace.fusionRunFailed": "A execução Fusion falhou",
    "trace.approvalWaiting": "A execução aguarda uma decisão humana explícita.",
    "trace.approvalAllowed": "Ação aprovada uma vez.",
    "trace.approvalDenied": "Ação negada ou expirada.",
    "trace.guidanceSent": "Nova orientação enviada à tarefa ativa.",
    "trace.detailTurnSession": "sessão={session}",
    "trace.detailTurnWorkflow": "sessão={session}; chave de workflow={workflowKey}",
    "trace.detailMemoryItems": "{count} elemento(s) de memória: {items}",
    "trace.detailMemoryNone": "{count} elemento(s) de memória: nenhum",
    "trace.detailExactRoute": "modelo={model}; nenhum consultor recebeu o pedido",
    "trace.detailAdvisoryPanel": "{usable}/{total} resposta(s) útil(eis) de consultores; modo={mode}",
    "trace.detailToolCalls": "{count} chamada(s) de ferramenta",
    "trace.detailReasoningProcessed": "{count} carateres de raciocínio privado processados",
    "trace.detailReasoningNotPersisted": "{count} carateres de raciocínio privado processados; conteúdo não guardado",
    "trace.detailFallbackAllowed": "{detail}; fallback permitido",
    "trace.detailFallbackBlocked": "{detail}; fallback bloqueado pelo registo de efeitos",
    "trace.detailFusionDuration": "{duration} ms",
    "trace.detailFusionEmptyOutput": "{duration} ms; resposta vazia",
    "trace.detailFusionNoCandidates": "{duration} ms; sem candidatos utilizáveis",
    "trace.detailFusionRunnerError": "{duration} ms; erro do executor",
    "trace.detailFusionTimeout": "{duration} ms; tempo limite excedido",
    "memory.aria": "Memória pesquisável",
    "memory.context": "CONTEXTO",
    "memory.title": "Memória",
    "memory.close": "Fechar memória",
    "memory.searchLabel": "Pesquisar decisões, factos e sessões",
    "memory.searchPlaceholder": "Exemplo: decisões sobre segurança",
    "memory.searchButton": "Pesquisar",
    "memory.allProjects": "Todos os projetos e sessões",
    "memory.scopeNote": "As sessões respeitam a seleção atual. A memória governada usa o scope configurado e pode ser transversal a projetos.",
    "memory.noResults": "Sem resultados para esta pesquisa.",
    "memory.kind": "MEMÓRIA",
    "memory.noPreview": "Registo sem pré-visualização",
    "memory.localContext": "Contexto local",
    "memory.confidence": "confiança {value}",
    "memory.kindEvidence": "EVIDÊNCIA",
    "memory.kindInstruction": "INSTRUÇÃO",
    "memory.kindPreference": "PREFERÊNCIA",
    "memory.kindProcedure": "PROCEDIMENTO",
    "memory.reviewPending": "Revisão pendente",
    "memory.reviewApproved": "Aprovada",
    "memory.reviewRejected": "Rejeitada",
    "routing.eyebrow": "ORQUESTRAÇÃO",
    "routing.title": "Fallback e Fusion/MoA",
    "routing.close": "Fechar configuração de routing",
    "routing.note":
      "As rotas globais podem enviar o pedido aos providers selecionados. Uma escolha explícita de modelo por sessão ou pedido permanece exata: não ativa fallback nem Fusion.",
    "routing.enable": "Ativar conselho multi-modelo",
    "routing.enableHelp": "Os participantes não têm ferramentas; o sintetizador recebe as respostas apenas como dados não confiáveis.",
    "routing.mode": "Modo",
    "routing.modeFusion": "Fusion — síntese final",
    "routing.modeMoa": "MoA — painel consultivo",
    "routing.maxParallel": "Concorrência máxima",
    "routing.participants": "Participantes (2–8 quando ativo)",
    "routing.participantsHelp": "Ctrl/Cmd + clique combina modelos de quaisquer providers, incluindo Neuralwatt.",
    "routing.synthesizer": "Sintetizador/juiz",
    "routing.fallback": "Fallback global (0–8, pela ordem apresentada)",
    "routing.fallbackHelp": "Vazio por defeito. Só é tentado enquanto a repetição for segura e nenhum efeito consequente tiver terminado.",
    "routing.cancel": "Cancelar",
    "routing.save": "Guardar routing",
    "routing.automatic": "Automático — usar o modelo principal",
    "routing.unavailable": "Indisponível — {selector}",
    "approval.eyebrow": "CONFIRMAÇÃO HUMANA",
    "approval.title": "Autorizar uma ação com efeitos?",
    "approval.note": "Lê o pedido completo. Aprova apenas se reconheces a intenção e o destino.",
    "approval.deny": "Negar",
    "approval.allowOnce": "Aprovar uma vez",
    "approval.noDescription": "O pedido não tem descrição; nega-o por segurança.",
    "common.unnamed": "Sem nome",
    "common.localProject": "Projeto local",
    "common.session": "Sessão",
    "common.folderUnavailable": "Pasta indisponível · {detail}",
    "common.noModels": "Sem modelos — inicia sessão ou configura um provider",
    "common.unavailable": "Indisponível",
    "common.automatic": "Automático",
    "common.you": "Tu",
    "common.youAvatar": "TU",
    "common.aiAvatar": "AI",
    "status.queued": "Em fila",
    "status.running": "Em execução",
    "status.active": "Ativa",
    "status.waiting": "Em espera",
    "status.completed": "Concluída",
    "status.failed": "Falhou",
    "status.stopped": "Parada",
    "status.cancelled": "Cancelada",
    "status.pending": "Pendente",
    "status.reviewed": "Revista",
    "status.dismissed": "Dispensada",
    "toast.routingSaved": "Routing guardado. As rotas explícitas continuam exatas.",
    "toast.chooseProject": "Escolhe primeiro um projeto.",
    "toast.chooseSession": "Escolhe primeiro uma sessão.",
    "toast.noChatModel": "Este provider não tem um modelo de chat disponível. Inicia sessão ou escolhe outro provider.",
    "toast.invalidEvent": "Foi ignorado um evento inválido.",
    "toast.activityDisconnected": "O canal de atividade foi interrompido.",
    "toast.initializeFailed": "Falha ao iniciar: {message}",
    "message.guidance": "Orientação: {message}",
    "field.projectId": "identificador do projeto",
    "field.sessionId": "identificador da sessão",
    "field.taskId": "identificador da tarefa",
    "field.approvalId": "identificador da aprovação",
    "field.query": "consulta de pesquisa",
    "field.provider": "provider",
    "field.title": "título da sessão",
    "field.message": "mensagem",
    "field.model": "modelo",
    "field.approvalDecision": "decisão de aprovação",
    "field.fusion": "configuração do Fusion",
    "field.fusionMode": "modo Fusion",
    "field.fallbackModels": "modelos de fallback",
    "field.fusionEnabled": "estado de ativação do Fusion",
    "field.fusionModels": "modelos Fusion",
    "field.synthesisModel": "modelo de síntese",
    "field.maxParallel": "concorrência máxima",
    "error.authenticationRequired": "É necessária autenticação.",
    "error.capabilityUnavailable": "Esta capacidade está indisponível.",
    "error.invalidHost": "O pedido usou um host inválido.",
    "error.loopbackOnly": "A UI só está disponível neste computador.",
    "error.proxyHeadersRejected": "A UI local não aceita headers de proxy.",
    "error.invalidOrigin": "O pedido veio de uma origem inválida.",
    "error.crossSiteRejected": "Foi rejeitado um pedido entre sites.",
    "error.originRequired": "É necessário um pedido da mesma origem.",
    "error.jsonRequired": "O pedido tem de usar JSON.",
    "error.bodyTooLarge": "O corpo do pedido é demasiado grande.",
    "error.invalidJson": "O pedido contém JSON inválido.",
    "error.objectRequired": "O corpo do pedido tem de ser um objeto.",
    "error.invalidRequest": "O pedido contém um valor inválido: {field}.",
    "error.invalidResponseLanguage": "O idioma das respostas tem de ser inglês ou português.",
    "error.methodNotAllowed": "Este método de pedido não é permitido.",
    "error.notFound": "O recurso pedido não foi encontrado.",
    "error.uiAssetMissing": "Falta um recurso necessário da UI.",
    "error.shuttingDown": "A UI local está a encerrar.",
    "error.responseTooLarge": "A resposta é demasiado grande para ser apresentada em segurança.",
    "error.starting": "A UI local ainda está a iniciar.",
    "error.requestFailed": "Não foi possível concluir o pedido local.",
    "error.internal": "Ocorreu um erro interno.",
    "error.network": "Não foi possível contactar a UI local.",
  }),
});

export function traceTitleDescriptor(event) {
  const type = firstString(event, ["type", "kind", "event"]);
  const eventKey = EVENT_TITLE_KEYS[type];
  if (eventKey) return descriptor(eventKey);

  const label = firstString(event, ["label", "title"]);
  const labelKey = STABLE_TRACE_LABEL_KEYS[label];
  if (labelKey) return descriptor(labelKey);

  const kind = firstString(event, ["kind"]);
  const phase = firstString(event, ["phase"]);
  const tool = firstString(event, ["tool"]);
  if (kind === "tool" && tool && label === `Tool ${tool}`) return descriptor("trace.toolNamed", { name: tool });

  if (kind !== "reasoning") return undefined;
  const consultant = /^Fusion consultant ([1-9][0-9]*) (queued|started|completed|failed)$/u.exec(label);
  if (consultant?.[1] && consultant[2] === phase) {
    const key = FUSION_TRACE_TITLE_KEYS[`consultant.${phase}`];
    if (key) return descriptor(key, { index: consultant[1] });
  }
  const stage = /^Fusion (synthesis|run) (queued|started|completed|failed)$/u.exec(label);
  if (stage?.[1] && stage[2] === phase) {
    const key = FUSION_TRACE_TITLE_KEYS[`${stage[1]}.${phase}`];
    if (key) return descriptor(key);
  }
  return undefined;
}

export function traceDetailDescriptor(event, value) {
  if (typeof value !== "string" || !value) return undefined;
  const label = firstString(event, ["label"]);

  if (label === "Turn started") {
    const match = /^session=([^;\r\n]+)(?:; workflow_key=([^\r\n]+))?$/u.exec(value);
    if (match?.[1]) {
      return match[2]
        ? descriptor("trace.detailTurnWorkflow", { session: match[1], workflowKey: match[2] })
        : descriptor("trace.detailTurnSession", { session: match[1] });
    }
  }
  if (label === "Governed memory recalled") {
    const match = /^(\d+) item\(s\): ([^\r\n]+)$/u.exec(value);
    if (match?.[1] && match[2]) {
      return match[2] === "none"
        ? descriptor("trace.detailMemoryNone", { count: match[1] })
        : descriptor("trace.detailMemoryItems", { count: match[1], items: match[2] });
    }
  }
  if (label === "Fusion skipped for exact model route") {
    const match = /^model=([^;\r\n]+); no consultant received the prompt$/u.exec(value);
    if (match?.[1]) return descriptor("trace.detailExactRoute", { model: match[1] });
  }
  if (label === "Multi-model advisory panel completed") {
    const match = /^(\d+)\/(\d+) usable consultant answer\(s\); mode=(fusion|moa)$/u.exec(value);
    if (match?.[1] && match[2] && match[3]) {
      return descriptor("trace.detailAdvisoryPanel", { usable: match[1], total: match[2], mode: match[3] });
    }
  }
  if (label === "Provider attempt completed") {
    const match = /^(\d+) tool call\(s\)$/u.exec(value);
    if (match?.[1]) return descriptor("trace.detailToolCalls", { count: match[1] });
  }
  if (label === "Provider reasoning in progress" || label === "Provider reasoning completed") {
    const match = /^(\d+) private reasoning characters processed(; content not persisted)?$/u.exec(value);
    if (match?.[1]) {
      return descriptor(match[2] ? "trace.detailReasoningNotPersisted" : "trace.detailReasoningProcessed", { count: match[1] });
    }
  }
  if (label === "Provider attempt failed before startup" || label === "Provider attempt failed") {
    const allowed = /^(.*); fallback=allowed$/u.exec(value);
    if (allowed?.[1]) return descriptor("trace.detailFallbackAllowed", { detail: allowed[1] });
    const blocked = /^(.*); fallback=blocked by side-effect ledger$/u.exec(value);
    if (blocked?.[1]) return descriptor("trace.detailFallbackBlocked", { detail: blocked[1] });
  }
  if (isFusionTraceLabel(event, label)) {
    const match = /^(\d+)ms(?:; reason=(timeout|runner_error|empty_output|no_candidates))?$/u.exec(value);
    if (match?.[1]) {
      const key = match[2] ? FUSION_REASON_DETAIL_KEYS[match[2]] : "trace.detailFusionDuration";
      if (key) return descriptor(key, { duration: match[1] });
    }
  }
  return undefined;
}

function descriptor(key, parameters = {}) {
  return { key, parameters };
}

function firstString(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) if (typeof value[key] === "string") return value[key];
  return "";
}

function isFusionTraceLabel(event, label) {
  if (firstString(event, ["kind"]) !== "reasoning") return false;
  const phase = firstString(event, ["phase"]);
  if (!Object.hasOwn(FUSION_TRACE_TITLE_KEYS, `consultant.${phase}`)) return false;
  const consultant = /^Fusion consultant [1-9][0-9]* (queued|started|completed|failed)$/u.exec(label);
  const stage = /^Fusion (?:synthesis|run) (queued|started|completed|failed)$/u.exec(label);
  return consultant?.[1] === phase || stage?.[1] === phase;
}

export function normalizeLocale(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("pt") ? "pt" : DEFAULT_LOCALE;
}

export function translate(locale, key, parameters = {}) {
  const normalized = normalizeLocale(locale);
  const template = translations[normalized][key] ?? translations[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, name) => (Object.hasOwn(parameters, name) ? String(parameters[name]) : match));
}

export function readStoredLocale(storage) {
  try {
    return normalizeLocale(storage?.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function persistLocale(storage, locale) {
  const normalized = normalizeLocale(locale);
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, normalized);
  } catch {
    // A blocked or full local store must not prevent the local UI from working.
  }
  return normalized;
}
