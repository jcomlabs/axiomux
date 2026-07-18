import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SENSITIVE_ROOT_NAMES = new Set([".git", ".superai", "node_modules"]);
const installationRootIdentities = new WeakSet<WorkspaceIdentity>();

export interface WorkspaceIdentity {
  /** Operator-selected path, fixed at link/agent construction time. */
  lexicalRoot: string;
  /** Physical directory resolved when the identity was captured. */
  rootPath: string;
  /** Filesystem identity, represented as strings so it remains JSON-safe. */
  device: string;
  inode: string;
  birthtimeNanoseconds: string;
}

/**
 * Canonicalize a user-linked workspace and keep the central Axiomux harness
 * outside its authority. The harness itself remains a valid explicit project,
 * while a broad parent folder is rejected because it would let workspace tools
 * rewrite the vault, policy and executable source.
 */
export function canonicalWorkspaceRoot(installationRoot: string, candidate: string): string {
  return createWorkspaceIdentity(installationRoot, candidate).rootPath;
}

/**
 * Capture a physical workspace identity, not just a pathname. Revalidating the
 * device/inode pair prevents a cached agent from silently following a folder
 * that was replaced by another directory or a junction after registration.
 */
export function createWorkspaceIdentity(installationRoot: string, candidate: string): WorkspaceIdentity {
  const installationIdentity = captureDirectoryIdentity(installationRoot, false);
  const installation = installationIdentity.rootPath;
  // The installed harness is the one intentional exception to the reserved-
  // segment rule. npm can place the package itself below node_modules, and the
  // harness must remain a valid bootstrap project there. No child or sibling
  // below a reserved segment inherits this exception.
  const isInstallationRoot = samePath(resolve(candidate), installationIdentity.lexicalRoot);
  const allowNpmInstallationRoot = isInstallationRoot && hasPathSegment(installation, "node_modules");
  const identity = captureDirectoryIdentity(candidate, !allowNpmInstallationRoot);
  if (allowNpmInstallationRoot) installationRootIdentities.add(identity);
  const workspace = identity.rootPath;

  const stateRoot = realpathIfPresent(join(installation, ".superai"));
  if (stateRoot && isWithin(stateRoot, workspace)) {
    throw new Error("The central Axiomux private state directory cannot be registered as, or contained by, a project workspace");
  }
  if (!samePath(workspace, installation) && isWithin(workspace, installation)) {
    throw new Error("A project workspace cannot be a parent of the Axiomux installation; choose the concrete project folder instead");
  }
  return identity;
}

/** Capture a standalone governed root for SourceHub/workspace-tool callers. */
export function captureWorkspaceIdentity(candidate: string): WorkspaceIdentity {
  return captureDirectoryIdentity(candidate, true);
}

/**
 * Fail closed when the registered path disappears, becomes a link/junction,
 * resolves elsewhere, or is replaced by another directory at the same path.
 */
export function revalidateWorkspaceIdentity(identity: WorkspaceIdentity): string {
  let lexicalInfo: ReturnType<typeof lstatSync>;
  try {
    lexicalInfo = lstatSync(identity.lexicalRoot);
  } catch (error) {
    throw new Error(`Workspace root is unavailable and must be relinked: ${identity.lexicalRoot}`, { cause: error });
  }
  if (lexicalInfo.isSymbolicLink()) {
    throw new Error("Workspace root became a symbolic link or junction; relink the physical project directory before continuing");
  }
  if (!lexicalInfo.isDirectory()) throw new Error(`Workspace root is no longer a directory: ${identity.lexicalRoot}`);

  let canonical: string;
  try {
    canonical = realpathSync.native(identity.lexicalRoot);
  } catch (error) {
    throw new Error(`Workspace root cannot be resolved and must be relinked: ${identity.lexicalRoot}`, { cause: error });
  }
  if (!installationRootIdentities.has(identity)) assertNoSensitiveSegments(canonical);
  if (!samePath(canonical, identity.rootPath)) {
    throw new Error("Workspace root now resolves to a different physical path; the cached project identity was rejected");
  }

  const current = statSync(canonical, { bigint: true });
  if (!current.isDirectory()) throw new Error(`Workspace root is not a directory: ${canonical}`);
  if (
    current.dev.toString() !== identity.device ||
    current.ino.toString() !== identity.inode ||
    current.birthtimeNs.toString() !== identity.birthtimeNanoseconds
  ) {
    throw new Error("Workspace root directory identity changed; relink the project before continuing");
  }
  return canonical;
}

export function sameWorkspaceIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return (
    samePath(left.rootPath, right.rootPath) &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNanoseconds === right.birthtimeNanoseconds &&
    installationRootIdentities.has(left) === installationRootIdentities.has(right)
  );
}

function captureDirectoryIdentity(candidate: string, rejectSensitiveSegments: boolean): WorkspaceIdentity {
  const lexicalRoot = resolve(candidate);
  if (rejectSensitiveSegments) assertNoSensitiveSegments(lexicalRoot);
  const lexicalInfo = lstatSync(lexicalRoot);
  if (lexicalInfo.isSymbolicLink()) {
    throw new Error("A symbolic-link or junction root cannot be registered as a project workspace; choose its physical directory instead");
  }
  if (!lexicalInfo.isDirectory()) throw new Error(`Project root is not a directory: ${lexicalRoot}`);
  const rootPath = realpathSync.native(lexicalRoot);
  if (rejectSensitiveSegments) assertNoSensitiveSegments(rootPath);
  const physical = statSync(rootPath, { bigint: true });
  if (!physical.isDirectory()) throw new Error(`Project root is not a directory: ${rootPath}`);
  return Object.freeze({
    lexicalRoot,
    rootPath,
    device: physical.dev.toString(),
    inode: physical.ino.toString(),
    birthtimeNanoseconds: physical.birthtimeNs.toString(),
  });
}

function assertNoSensitiveSegments(path: string): void {
  const sensitive = resolve(path)
    .split(/[\\/]+/u)
    .map((segment) => segment.toLocaleLowerCase())
    .find((segment) => SENSITIVE_ROOT_NAMES.has(segment));
  if (sensitive) {
    throw new Error(`A path containing the ${sensitive} control/state segment cannot be registered as a project workspace`);
  }
}

function hasPathSegment(path: string, requested: string): boolean {
  const normalized = requested.toLocaleLowerCase();
  return resolve(path)
    .split(/[\\/]+/u)
    .some((segment) => segment.toLocaleLowerCase() === normalized);
}

function realpathIfPresent(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const result = relative(parent, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}
