import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const TEXT_FILENAMES = new Set([".editorconfig", ".env.example", ".gitattributes", ".gitignore", "Dockerfile", "LICENSE", "Makefile"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const PORTUGUESE_LOCALE_FILE = "ui/locales.js";
// Only marked lines in these files may contain Portuguese input compatibility
// data. The marker never suppresses mojibake detection.
const PORTUGUESE_INPUT_FILES = new Set([
  "scripts/language-audit.mjs",
  "src/memory/store.ts",
  "src/rpc/omp-client.ts",
  "src/runtime/supervisor.ts",
  "src/security/prompt.ts",
  "test/prompt-security.test.ts",
  "test/supervisor.test.ts",
  "test/ui-server.test.ts",
]);
const PORTUGUESE_INPUT_MARKER = /(?:\/\/|#)\s*language-audit:\s*allow-portuguese-input\b/;
const ADJACENT_PORTUGUESE_INPUT_MARKER = /^\s*(?:\/\/|#)\s*language-audit:\s*allow-portuguese-input\s*$/;

// This heuristic favors Portuguese-specific vocabulary and common phrases. It
// cannot prove language or catch every short ASCII-only phrase; broad shared
// Romance-language tokens and proper names are deliberately omitted to avoid
// false positives in otherwise-English publications.
const PORTUGUESE_MARKER =
  /\b(?:a[cç][aã]o|a[cç][oõ]es|abrir|acrescenta|adicionar|agente ativo|ainda n[aã]o|alterar|aplica[cç][aã]o|aprova(?:r|do|da)|atualiza[cç][aã]o|atualizar|autentica(?:r|[cç][aã]o)|aviso|bem[- ]vind[oa]s?|bom dia|cancelar|carregar|cat[aá]logo|chave de api|clique|c[oó]digo|como vai|configura[cç][aã]o|conclu[ií]d[oa]|continuar|corrigir|credencia(?:l|is)|criar|deixa-me|desativar|desligad[oa]|dispon[ií]vel|documenta isto|escolha|escolher|est[aá] tudo|estado|execu[cç][aã]o|executar|fechar|ficheiros?|ferramentas?|fontes?|guardad[oa]|guardar|informa[cç][aã]o|iniciar|instalar|introduz|inv[aá]lid[oa]|ligad[oa]|mais testes|mem[oó]rias?|modelos?|mostrar|n[aã]o|nenhum[ao]?|obrigad[oa]|op[cç][aã]o|op[cç][oõ]es|orienta[cç][aã]o|p[aá]gina|palavra-passe|para agora|pastas?|pedidos?|podes?|por favor|precis[ao]|procurar|pr[oó]xim[oa]s?|projetos?|qual (?:e|é) o estado|quero|remover|respostas?|rever|revis[aã]o|selecionar?|selecione|senhas?|sess(?:a|ã)o|sess(?:o|õ)es|tarefas?|tem de|terminar|tente novamente|utilizadores?|v[aá]rias mentes|vamos|verificar|voltar)\b/giu; // language-audit: allow-portuguese-input
const MOJIBAKE = /(?:\u00c3[\u0080-\u00bf]|\u00c2[\u0080-\u00bf]|\u00e2\u20ac|\u00ef\u00bf\u00bd|\ufffd)/gu;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).sort();

const violations = [];
let checked = 0;

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (!isTextCandidate(normalized)) continue;
  if (!existsSync(file)) continue;
  const stats = statSync(file);
  if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) continue;

  const content = readFileSync(file, "utf8");
  checked += 1;
  collectMatches(normalized, content, MOJIBAKE, "mojibake");

  collectPortugueseMatches(normalized, content);
}

if (violations.length) {
  console.error("English publication audit failed:");
  for (const violation of violations.slice(0, 100)) console.error(`- ${violation.file}:${violation.line}: ${violation.kind}: ${violation.match}`);
  if (violations.length > 100) console.error(`- ... ${violations.length - 100} additional violation(s)`);
  process.exitCode = 1;
} else {
  console.log(
    `English publication audit passed: ${checked} text file(s) checked; Portuguese is confined to ${PORTUGUESE_LOCALE_FILE} and explicitly marked input-safety lines.`,
  );
}

function isTextCandidate(file) {
  const name = file.split("/").at(-1) ?? file;
  return TEXT_FILENAMES.has(name) || TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function collectMatches(file, content, pattern, kind) {
  pattern.lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    violations.push({
      file,
      line: content.slice(0, index).split("\n").length,
      kind,
      match: JSON.stringify(match[0]),
    });
  }
}

function collectPortugueseMatches(file, content) {
  const lines = content.split(/\r?\n/u);
  let localeSection;
  let continuedLocaleValue = false;
  for (const [offset, line] of lines.entries()) {
    if (file === PORTUGUESE_LOCALE_FILE) {
      const section = /^\s*(en|pt): Object\.freeze\(\{\s*$/u.exec(line)?.[1];
      if (section) localeSection = section;
    }
    const markerOnLine = PORTUGUESE_INPUT_MARKER.test(line);
    const markerOnPreviousLine = offset > 0 && ADJACENT_PORTUGUESE_INPUT_MARKER.test(lines[offset - 1] ?? "");
    if (markerOnLine && !PORTUGUESE_INPUT_FILES.has(file)) {
      violations.push({
        file,
        line: offset + 1,
        kind: "unauthorized Portuguese-input exemption",
        match: JSON.stringify("language-audit: allow-portuguese-input"),
      });
      continue;
    }
    if ((markerOnLine || markerOnPreviousLine) && PORTUGUESE_INPUT_FILES.has(file)) continue;

    PORTUGUESE_MARKER.lastIndex = 0;
    for (const match of line.matchAll(PORTUGUESE_MARKER)) {
      if (file === PORTUGUESE_LOCALE_FILE && isAllowedLocaleValue(line, localeSection, continuedLocaleValue)) continue;
      violations.push({
        file,
        line: offset + 1,
        kind: "Portuguese public text",
        match: JSON.stringify(match[0]),
      });
    }
    continuedLocaleValue = file === PORTUGUESE_LOCALE_FILE && localeSection === "pt" && /^\s*"[A-Za-z0-9.]+"\s*:\s*$/u.test(line);
    if (file === PORTUGUESE_LOCALE_FILE && localeSection && /^\s*\}\),?\s*$/u.test(line)) localeSection = undefined;
  }
}

function isAllowedLocaleValue(line, localeSection, continuedLocaleValue) {
  const translationLine = /^\s*"[A-Za-z0-9.]+"\s*:\s*"(?:[^"\\]|\\.)*",?\s*$/u.test(line);
  if (translationLine) {
    if (localeSection === "pt") return true;
    return localeSection === "en" && /^\s*"language\.portuguese"\s*:/u.test(line);
  }
  return localeSection === "pt" && continuedLocaleValue && /^\s*"(?:[^"\\]|\\.)*",?\s*$/u.test(line);
}
