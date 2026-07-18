import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const config = JSON.parse(readFileSync(new URL("../config/brand-migration.json", import.meta.url), "utf8"));
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const check = args.has("--check");
const textExtensions = new Set([
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
const textFilenames = new Set([".editorconfig", ".env.example", ".gitattributes", ".gitignore", "Dockerfile", "LICENSE", "Makefile"]);
const maxTextBytes = 2 * 1024 * 1024;
const controlFiles = new Set(config.migrationControlFiles);
const legacyAllowlist = new Map(Object.entries(config.legacyPublicBrandAllowlist));
const expectedFiles = new Set(config.expectedPublicBrandFiles);
const publicPattern = new RegExp(escapeRegex(config.current.publicToken), "giu");
const legacyPublicPatterns = config.previousPublicBrands.map(({ publicToken }) => new RegExp(escapeRegex(publicToken), "giu"));
const compatibilityPattern = new RegExp(config.compatibility.tokens.map(escapeRegex).join("|"), "giu");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"))
  .sort();

const publicBrand = [];
const legacyPublicBrand = [];
const legacyAllowlistDrift = [];
const compatibility = [];
for (const file of files) {
  if (!isTextCandidate(file) || !existsSync(file)) continue;
  const stats = statSync(file);
  if (!stats.isFile() || stats.size > maxTextBytes) continue;
  const content = readFileSync(file, "utf8");
  if (!controlFiles.has(file)) {
    const matches = content.match(publicPattern);
    if (matches?.length) publicBrand.push({ file, occurrences: matches.length });
  }
  const legacyOccurrences = legacyPublicPatterns.reduce((total, pattern) => total + (content.match(pattern)?.length ?? 0), 0);
  const expectedLegacyOccurrences = legacyAllowlist.get(file);
  if (legacyOccurrences && expectedLegacyOccurrences === undefined) legacyPublicBrand.push({ file, occurrences: legacyOccurrences });
  if (expectedLegacyOccurrences !== undefined && legacyOccurrences !== expectedLegacyOccurrences) {
    legacyAllowlistDrift.push({ file, expected: expectedLegacyOccurrences, actual: legacyOccurrences });
  }
  const compatibilityMatches = content.match(compatibilityPattern);
  if (compatibilityMatches?.length) compatibility.push({ file, occurrences: compatibilityMatches.length });
}

const actualFiles = new Set(publicBrand.map(({ file }) => file));
const unexpected = [...actualFiles].filter((file) => !expectedFiles.has(file)).sort();
const missing = [...expectedFiles].filter((file) => !actualFiles.has(file)).sort();
const report = {
  schemaVersion: config.schemaVersion,
  currentBrand: config.current,
  previousPublicBrands: config.previousPublicBrands,
  compatibilityPolicy: config.compatibility,
  summary: {
    publicBrandFiles: publicBrand.length,
    publicBrandOccurrences: publicBrand.reduce((total, entry) => total + entry.occurrences, 0),
    compatibilityFiles: compatibility.length,
    compatibilityOccurrences: compatibility.reduce((total, entry) => total + entry.occurrences, 0),
    legacyPublicBrandFiles: legacyPublicBrand.length,
    legacyPublicBrandOccurrences: legacyPublicBrand.reduce((total, entry) => total + entry.occurrences, 0),
    legacyAllowlistDrift: legacyAllowlistDrift.length,
    unexpectedFiles: unexpected.length,
    missingFiles: missing.length,
  },
  publicBrand,
  legacyPublicBrand,
  legacyAllowlistDrift,
  compatibility,
  drift: { unexpected, missing },
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Brand audit: ${report.summary.publicBrandOccurrences} public-brand occurrence(s) in ${report.summary.publicBrandFiles} file(s); ` +
      `${report.summary.compatibilityOccurrences} compatibility occurrence(s) in ${report.summary.compatibilityFiles} file(s).`,
  );
  console.log(
    `Legacy public brand: ${report.summary.legacyPublicBrandOccurrences} disallowed occurrence(s) in ` +
      `${report.summary.legacyPublicBrandFiles} file(s); inventory drift: ${unexpected.length} unexpected, ${missing.length} missing.`,
  );
  if (legacyPublicBrand.length) console.log(`Disallowed legacy-brand files:\n- ${legacyPublicBrand.map(({ file }) => file).join("\n- ")}`);
  if (legacyAllowlistDrift.length) {
    console.log(
      `Legacy-brand allowlist count drift:\n- ${legacyAllowlistDrift.map(({ file, expected, actual }) => `${file}: expected ${expected}, found ${actual}`).join("\n- ")}`,
    );
  }
  if (unexpected.length) console.log(`Unexpected public-brand files:\n- ${unexpected.join("\n- ")}`);
  if (missing.length) console.log(`Expected files without the current public brand:\n- ${missing.join("\n- ")}`);
}

if (check && (legacyPublicBrand.length > 0 || legacyAllowlistDrift.length > 0 || unexpected.length > 0 || missing.length > 0)) process.exitCode = 1;

function isTextCandidate(file) {
  const name = file.split("/").at(-1) ?? file;
  return textFilenames.has(name) || textExtensions.has(extname(name).toLowerCase());
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
