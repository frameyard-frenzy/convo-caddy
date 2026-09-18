import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const PACKAGE_REQUIRED_PATHS = [
  "package.json",
  "LICENSE",
  "dist/client/index.html",
  "dist/client/convo-caddy-mark.svg",
  "dist/client/FONT-LICENSES.txt",
  "dist/desktop/main.mjs",
  "dist/desktop/build-provenance.json",
  "dist/desktop/recording-notice.jpg",
  "dist/desktop/instrument-sans.woff2",
  "dist/desktop/hermes-connection-setup.md",
  "dist/desktop/lifecycle-lock.node",
] as const;

const ALLOWED_FILE_PATHS = new Set<string>(PACKAGE_REQUIRED_PATHS);
const ALLOWED_DIRECTORY_PATHS = [
  "config",
  "dist",
  "dist/client",
  "dist/desktop",
  "node_modules",
] as const;
const ALLOWED_RECURSIVE_DIRECTORY_PATHS = [
  "dist/client",
  "dist/desktop",
  "node_modules",
] as const;
const FORBIDDEN_NODE_MODULE_PATHS = [
  "node_modules/.bin",
  "node_modules/.modules.yaml",
  "node_modules/.package-map.json",
  "node_modules/.pnpm",
  "node_modules/.pnpm-workspace-state-v1.json",
  "node_modules/.vite",
  "node_modules/.vite-temp",
  "node_modules/electron",
  "node_modules/@electron-forge",
  "node_modules/@playwright",
  "node_modules/@types",
  "node_modules/@vitest",
  "node_modules/esbuild",
  "node_modules/playwright",
  "node_modules/playwright-core",
  "node_modules/tsx",
  "node_modules/typescript",
  "node_modules/vite",
  "node_modules/vitest",
] as const;
const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024;
const SECRET_PATTERNS = [
  /whsec_[A-Za-z0-9+/]{16,}={0,2}/,
  /CONVO_CADDY_(?:RECALL_API_KEY|RECALL_VERIFICATION_SECRET|NGROK_AUTHTOKEN|HERMES_API_KEY)\s*=\s*(?:["'][^"'\r\n]+["']|[^\s"'`;]+)/,
] as const;

export function isAllowedApplicationPath(candidate: string): boolean {
  const normalized = normalizeRelativePath(candidate);
  if (normalized === null || normalized === "") {
    return normalized === "";
  }
  if (isPathWithinAny(normalized, FORBIDDEN_NODE_MODULE_PATHS)) {
    return false;
  }
  if (ALLOWED_FILE_PATHS.has(normalized)) {
    return true;
  }
  return (
    ALLOWED_DIRECTORY_PATHS.includes(
      normalized as (typeof ALLOWED_DIRECTORY_PATHS)[number],
    ) ||
    ALLOWED_RECURSIVE_DIRECTORY_PATHS.some((directory) =>
      normalized.startsWith(`${directory}/`),
    )
  );
}

export function createPackageIgnore(
  projectRoot: string,
): (file: string) => boolean {
  const absoluteRoot = path.resolve(projectRoot);
  return (file) => {
    const resolved = path.resolve(file);
    const relative =
      resolved === absoluteRoot ||
      resolved.startsWith(`${absoluteRoot}${path.sep}`)
        ? path.relative(absoluteRoot, resolved)
        : file.replace(/^[/\\]+/, "");
    if (relative === "") {
      return false;
    }
    return !isAllowedApplicationPath(relative);
  };
}

export function assertSafePackagedFiles(applicationRoot: string): void {
  const absoluteRoot = path.resolve(applicationRoot);
  for (const requiredPath of PACKAGE_REQUIRED_PATHS) {
    if (!existsSync(path.join(absoluteRoot, requiredPath))) {
      throw new Error(`Missing required packaged path: ${requiredPath}`);
    }
  }

  walk(absoluteRoot, (absolutePath) => {
    const relative = toPosix(path.relative(absoluteRoot, absolutePath));
    if (!isAllowedApplicationPath(relative)) {
      throw new Error(`Disallowed packaged path: ${relative}`);
    }
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Packaged application path must not be a symlink: ${relative}`,
      );
    }
    if (!metadata.isFile() || metadata.size > MAX_SCANNED_FILE_BYTES) {
      return;
    }
    const bytes = readFileSync(absolutePath);
    if (containsSecretLikeContent(bytes)) {
      throw new Error(
        `Secret-like content found in packaged path: ${relative}`,
      );
    }
  });
}

export function containsSecretLikeContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  const contents = Buffer.from(bytes).toString("utf8");
  return SECRET_PATTERNS.some((pattern) => pattern.test(contents));
}

export function assertProductionDependencyClosure(
  applicationRoot: string,
  stagedNodeModules: string,
): void {
  const packagedNodeModules = path.join(applicationRoot, "node_modules");
  if (!existsSync(packagedNodeModules)) {
    throw new Error("The packaged production dependency tree is missing.");
  }
  if (!existsSync(stagedNodeModules)) {
    throw new Error("The staged production dependency tree is missing.");
  }
  const expected = listDependencyRoots(stagedNodeModules);
  const actual = listDependencyRoots(packagedNodeModules);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const unexpected = actual.filter((root) => !expected.includes(root));
    const missing = expected.filter((root) => !actual.includes(root));
    throw new Error(
      `Packaged dependency roots differ from the production stage. Unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}.`,
    );
  }
}

export function assertAllowedAsarEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = entry.replace(/^\/+/, "");
    if (!isAllowedApplicationPath(normalized)) {
      throw new Error(`Disallowed ASAR path: ${normalized}`);
    }
  }
  for (const requiredPath of PACKAGE_REQUIRED_PATHS) {
    if (!entries.some((entry) => entry.replace(/^\/+/, "") === requiredPath)) {
      throw new Error(`Missing required ASAR path: ${requiredPath}`);
    }
  }
}

export function writePackagedManifest(applicationRoot: string): void {
  const manifestFile = path.join(applicationRoot, "package.json");
  const source = JSON.parse(readFileSync(manifestFile, "utf8")) as {
    dependencies?: Record<string, string>;
    description?: string;
    license?: string;
    name?: string;
    version?: string;
  };
  if (!source.name || !source.version || !source.dependencies) {
    throw new Error("The source package manifest is incomplete.");
  }
  writeFileSync(
    manifestFile,
    `${JSON.stringify(
      {
        name: source.name,
        productName: "Convo Caddy",
        version: source.version,
        description: source.description,
        author: "Frameyard",
        license: source.license ?? "MIT",
        private: true,
        type: "module",
        main: "dist/desktop/main.mjs",
        dependencies: source.dependencies,
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
}

export function installStagedProductionDependencies(
  applicationRoot: string,
  stagedNodeModules: string,
): void {
  if (!existsSync(stagedNodeModules)) {
    throw new Error("The staged production dependency tree is missing.");
  }
  const destination = path.join(applicationRoot, "node_modules");
  rmSync(destination, { recursive: true, force: true });
  cpSync(stagedNodeModules, destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
  });
}

function walk(root: string, visit: (absolutePath: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    visit(absolutePath);
    if (entry.isDirectory()) {
      walk(absolutePath, visit);
    }
  }
}

function listDependencyRoots(nodeModules: string): string[] {
  const roots: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    if (!entry.name.startsWith("@")) {
      roots.push(entry.name);
      continue;
    }
    for (const child of readdirSync(path.join(nodeModules, entry.name), {
      withFileTypes: true,
    })) {
      if (child.isDirectory()) {
        roots.push(`${entry.name}/${child.name}`);
      }
    }
  }
  return roots.sort();
}

function isPathWithinAny(
  candidate: string,
  boundaries: readonly string[],
): boolean {
  return boundaries.some(
    (boundary) =>
      candidate === boundary || candidate.startsWith(`${boundary}/`),
  );
}

function normalizeRelativePath(candidate: string): string | null {
  if (path.isAbsolute(candidate)) {
    return null;
  }
  const normalized = path.posix
    .normalize(toPosix(candidate))
    .replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized === "." ? "" : normalized;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
