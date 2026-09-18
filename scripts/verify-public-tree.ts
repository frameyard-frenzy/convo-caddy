import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const PUBLIC_TREE_ALLOWLIST = [
  ".env.example",
  ".collab",
  "AGENTS.md",
  "CLAUDE.md",
  ".editorconfig",
  "playwright.setup.config.ts",
  "playwright.clarity.config.ts",
  ".github",
  ".gitignore",
  ".nvmrc",
  "LICENSE",
  "NOTICE.md",
  "native",
  "README.md",
  "SECURITY.md",
  "assets",
  "biome.json",
  "docs",
  "fixtures",
  "forge.config.ts",
  "index.html",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "public",
  "scripts",
  "src",
  "tests",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
] as const;

const FORBIDDEN_TOP_LEVEL = [
  "artifacts",
  "collab",
  ".marty",
  ".codex",
  ".hermes",
] as const;
const TEXT_LIMIT = 8 * 1024 * 1024;

/** Inspect committed HEAD only. No source writes, git init, or export commits. */
export function verifyPublicTree(source: string): {
  commit: string;
  files: number;
} {
  const snapshot = mkdtempSync(path.join(tmpdir(), "caddy-public-check-"));
  try {
    const commit = git(source, ["rev-parse", "HEAD"]);
    const entries = git(source, ["ls-tree", "-rz", commit])
      .split("\0")
      .filter(Boolean);
    const files = entries.map((entry) => {
      const split = entry.indexOf("\t");
      const metadata = entry.slice(0, split);
      const relative = entry.slice(split + 1);
      const match = /^100(?:644|755) blob ([a-f0-9]{40})$/.exec(metadata);
      if (
        !match ||
        !PUBLIC_TREE_ALLOWLIST.some(
          (allowed) =>
            relative === allowed || relative.startsWith(`${allowed}/`),
        )
      ) {
        throw new Error(
          `Non-public or non-regular tracked source: ${relative}`,
        );
      }
      return { relative, object: match[1]! };
    });
    // Read actual blob IDs in one process. Size framing preserves binary bytes
    // and paths with tabs/newlines; no archive attributes or replacement refs.
    const blobs = execFileSync(
      "git",
      ["--no-replace-objects", "cat-file", "--batch"],
      {
        cwd: source,
        input: files.map(({ object }) => `${object}\n`).join(""),
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    let offset = 0;
    for (const { relative, object } of files) {
      const headerEnd = blobs.indexOf(10, offset);
      const header = blobs.subarray(offset, headerEnd).toString("ascii");
      const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
      const size = Number(match?.[2]);
      const begin = headerEnd + 1;
      const end = begin + size;
      if (
        headerEnd < offset ||
        match?.[1] !== object ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        end >= blobs.length ||
        blobs[end] !== 10
      )
        throw new Error(`Invalid Git blob response: ${relative}`);
      const target = path.join(snapshot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, blobs.subarray(begin, end));
      offset = end + 1;
    }
    if (offset !== blobs.length) throw new Error("Unexpected Git blob data");
    assertPublicCandidate(snapshot);
    assertNoHighConfidenceSecrets(snapshot);
    assertDocumentationReferences(snapshot);
    return { commit, files: entries.length };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

export function assertNoHighConfidenceSecrets(
  root: string,
  excludedDirectories: readonly string[] = [],
): void {
  const patterns = [
    new RegExp(["AKIA", "[A-Z0-9]{16}"].join("")),
    new RegExp(["gh", "p_[A-Za-z0-9]{30,}"].join("")),
    new RegExp(["sk-", "[A-Za-z0-9]{32,}"].join("")),
    new RegExp(
      ["-----BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"].join(""),
    ),
  ];
  for (const file of walkFiles(root, new Set(excludedDirectories))) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.size > TEXT_LIMIT) continue;
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue;
    if (patterns.some((pattern) => pattern.test(bytes.toString("utf8")))) {
      throw new Error(
        `High-confidence secret found in ${path.relative(root, file)}`,
      );
    }
  }
}

export function assertPublicCandidate(root: string): void {
  for (const forbidden of FORBIDDEN_TOP_LEVEL) {
    if (existsSync(path.join(root, forbidden))) {
      throw new Error(`Private path is present in candidate: ${forbidden}`);
    }
  }
  for (const file of walkFiles(root)) {
    const relative = path.relative(root, file);
    if (relative.startsWith(`.git${path.sep}`)) continue;
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Candidate path must not be a symlink: ${relative}`);
    }
    if (!metadata.isFile() || metadata.size > TEXT_LIMIT) continue;
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue;
    assertSanitizedText(relative, bytes.toString("utf8"));
  }
  for (const required of [
    "scripts/verify-install-uninstall-mac.ts",
    "tests/package/install-uninstall-contract.test.ts",
    "docs/install-uninstall-verification.md",
  ]) {
    if (!existsSync(path.join(root, required)))
      throw new Error(`Missing install/uninstall public contract: ${required}`);
  }
}

function assertSanitizedText(relative: string, contents: string): void {
  const personalPath = ["", "Users", ""].join("/");
  if (
    contents.includes(personalPath) ||
    /\/home\/[a-z][a-z0-9_-]*\//i.test(contents)
  ) {
    throw new Error(`Absolute personal path found in ${relative}`);
  }
  // Structural rules detect private endpoints without storing personal values.
  // Reserved example domains and symbolic placeholders remain usable fixtures.
  const hostedEndpoints =
    contents.match(
      /\b(?:[a-z0-9-]+\.)+(?:ngrok-free\.(?:dev|app)|ts\.net)\b/gi,
    ) ?? [];
  const unsafeEndpoint = hostedEndpoints.some(
    (host) =>
      !/(?:^|\.)example\.(?:ngrok-free\.(?:dev|app)|ts\.net)$/i.test(host),
  );
  if (unsafeEndpoint) {
    throw new Error(`Private endpoint found in ${relative}`);
  }
}

/** Resolve local Markdown links and documented pnpm scripts/configs fail closed. */
export function assertDocumentationReferences(root: string): void {
  const scripts =
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ??
    {};
  const docs = walkFiles(root).filter((file) => {
    const relative = path.relative(root, file);
    return (
      /\.md$/.test(file) &&
      (/^(?:README|AGENTS|CLAUDE)\.md$/.test(relative) ||
        /^(?:docs|\.collab)\//.test(relative))
    );
  });
  for (const file of docs) {
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target =
        (match[1] ?? "").replace(/^<|>$/g, "").split("#")[0]?.split("?")[0] ??
        "";
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (
        !existsSync(
          path.resolve(path.dirname(file), decodeURIComponent(target)),
        )
      )
        throw new Error(
          `Missing documentation link in ${path.relative(root, file)}: ${target}`,
        );
    }
    const commands = [...contents.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)]
      .map((match) => match[0])
      .join("\n");
    assertCommandReferences(commands);
    assertConfigReferences(contents);
  }

  // Check every package script, including chains, without executing commands.
  // Only the repository's plain pnpm, source-path and --config shapes are parsed;
  // external tools and generated dist outputs are intentionally not resolved.
  for (const command of Object.values(scripts)) {
    if (typeof command === "string") assertCommandReferences(command);
  }
  function assertCommandReferences(commands: string): void {
    for (const match of commands.matchAll(
      /\bpnpm\s+(?:--filter\s+[\w@./*-]+\s+)?(?:run\s+)?([a-z][a-z0-9:-]*)/g,
    )) {
      const command = match[1] ?? "";
      if (
        ![
          "install",
          "exec",
          "add",
          "remove",
          "audit",
          "dlx",
          "deploy",
        ].includes(command) &&
        !(command in scripts)
      )
        throw new Error(`Unknown documented pnpm command: ${command}`);
    }
    for (const match of commands.matchAll(
      /\b((?:scripts|native|tests|src)\/[\w./-]+\.(?:sh|ts|py|js))\b/g,
    )) {
      if (!existsSync(path.join(root, match[1] ?? "")))
        throw new Error(`Missing documented script: ${match[1]}`);
    }
    assertConfigReferences(commands);
  }
  function assertConfigReferences(commands: string): void {
    for (const match of commands.matchAll(
      /--config(?:\s+|=)["']?([\w./-]+\.(?:ts|js|json))/g,
    )) {
      if (!existsSync(path.join(root, match[1] ?? "")))
        throw new Error(`Missing documented configuration: ${match[1]}`);
    }
  }
}

function walkFiles(root: string, excluded = new Set<string>()): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else files.push(absolute);
    }
  }
  return files;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((argument) => argument !== "--"))
    throw new Error("Usage: pnpm verify:public-tree");
  process.stdout.write(
    `${JSON.stringify({ status: "ok", ...verifyPublicTree(path.resolve(".")) }, null, 2)}\n`,
  );
}
