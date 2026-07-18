import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const detectors = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u],
  ["openai-style-key", /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/u],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["stripe-live-key", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/u],
];

const root = resolve(process.cwd());
const git = resolveTool("git", root);
const tracked = execFileSync(git, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const findings = [];
let scanned = 0;
let skippedBinaryOrLarge = 0;
for (const relative of tracked) {
  const absolute = resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`Refusing to scan path outside repository: ${relative}`);
  if (!existsSync(absolute)) continue; // Tracked deletion; its old blob is covered by the history scan below.
  const stat = lstatSync(absolute);
  if (stat.isDirectory()) continue;
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute), "utf8") : readFileSync(absolute);
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) {
    skippedBinaryOrLarge += 1;
    continue;
  }
  scanned += 1;
  const text = bytes.toString("utf8");
  for (const [name, detector] of detectors) {
    if (detector.test(text)) findings.push({ surface: "worktree", file: relative.replaceAll("\\", "/"), detector: name });
  }
}

let history = "";
try {
  history = execFileSync(git, ["log", "--all", "--format=", "--no-ext-diff", "--no-color", "-p", "--", "."], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
} catch (error) {
  throw new Error("Unable to inspect Git history for secrets", { cause: error });
}
for (const [name, detector] of detectors) {
  if (detector.test(history)) findings.push({ surface: "history", detector: name });
}

if (findings.length > 0) {
  console.error("Potential high-confidence secrets detected (matching values are intentionally not printed):");
  for (const finding of findings) {
    console.error(`- ${finding.surface}${finding.file ? `:${finding.file}` : ""} [${finding.detector}]`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed: ${scanned} text files and Git patch history checked; ${skippedBinaryOrLarge} binary/large file(s) skipped.`);
}

function resolveTool(name, rejectedRoot) {
  const pathKey = process.platform === "win32" ? Object.keys(process.env).find((key) => key.toLocaleLowerCase() === "path") : "PATH";
  const value = pathKey ? (process.env[pathKey] ?? "") : "";
  const names = process.platform === "win32" && !extname(name) ? [`${name}.exe`] : [name];
  for (const rawDirectory of value.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (!directory || !isAbsolute(directory)) continue;
    for (const candidateName of names) {
      try {
        const candidate = realpathSync.native(join(directory, candidateName));
        const rel = relative(realpathSync.native(rejectedRoot), candidate);
        if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) continue;
        const info = statSync(candidate);
        if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o111) === 0)) continue;
        return candidate;
      } catch {
        // Continue through absolute PATH entries only.
      }
    }
  }
  throw new Error(`Trusted ${name} executable was not found outside the repository`);
}
