import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProductionDependencyClosure,
  assertSafePackagedFiles,
  createPackageIgnore,
  isAllowedApplicationPath,
  PACKAGE_REQUIRED_PATHS,
  writePackagedManifest,
} from "../../scripts/lib/package-contract.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("macOS package contract", () => {
  it("requires the bundled remote guide beside the packaged setup runtime", () => {
    expect(PACKAGE_REQUIRED_PATHS).toContain(
      "dist/desktop/hermes-connection-setup.md",
    );
  });
  it("uses a flat Frameyard-family palette for the Convo Caddy app icon", () => {
    const icon = readFileSync(path.resolve("assets/app-icon.svg"), "utf8");

    expect(icon).toContain("#5A603D");
    expect(icon).toContain("#F3F5F1");
    expect(icon).toContain("#2E7158");
    expect(icon).not.toContain("linearGradient");
    expect(icon).not.toContain("#D87755");
  });

  it("keeps the source build portable and the icon build macOS-specific", () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve("package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.build).toBe(
      "pnpm build:client && pnpm build:desktop",
    );
    expect(manifest.scripts?.["build:mac"]).toBe(
      "pnpm build && pnpm build:icon && pnpm build:uninstaller",
    );
    expect(manifest.scripts?.["make:mac"]).toMatch(
      /^pnpm prepare:package:mac && pnpm build:mac/,
    );
    expect(manifest.scripts?.["package:mac"]).toMatch(
      /^pnpm prepare:package:mac && pnpm build:mac/,
    );
  });

  it("accepts Electron Packager's root-relative ignore paths", () => {
    const ignore = createPackageIgnore("/tmp/convo-caddy-project");
    expect(ignore("/package.json")).toBe(false);
    expect(ignore("/dist/desktop/main.mjs")).toBe(false);
    expect(ignore("/README.md")).toBe(true);
  });

  it("allows only the compiled runtime, production dependencies, and approved assets", () => {
    for (const packagedPath of [
      "package.json",
      "dist/client/index.html",
      "dist/desktop/main.mjs",
      "dist/desktop/build-provenance.json",
      "dist/desktop/recording-notice.jpg",
      "dist/desktop/instrument-sans.woff2",
      "dist/desktop/hermes-connection-setup.md",
      "dist/desktop/lifecycle-lock.node",
      "node_modules/@ngrok/ngrok/index.js",
      "node_modules/@ngrok/ngrok-darwin-arm64/ngrok.darwin-arm64.node",
      "node_modules/express/index.js",
    ]) {
      expect(isAllowedApplicationPath(packagedPath)).toBe(true);
    }

    for (const rejectedPath of [
      ".env",
      ".git/config",
      "AGENTS.md",
      "README.md",
      ".collab/COLLABORATION.md",
      "fixtures/simulated-interview.jsonl",
      "scripts/recall-fixture-listener.ts",
      "src/desktop/main.ts",
      "node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js",
      "test-results/report.json",
      "tests/fixtures/recall/001-transcript-data.json",
      "var/sessions/active-session.json",
    ]) {
      expect(isAllowedApplicationPath(rejectedPath)).toBe(false);
    }
  });

  it("requires every production artifact needed by the packaged runtime", () => {
    expect(PACKAGE_REQUIRED_PATHS).toEqual([
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
    ]);
  });

  it("replaces the source manifest with a minimal production manifest", () => {
    const root = createTemporaryDirectory();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        name: "convo-caddy",
        version: "0.1.0",
        description: "Private interview companion",
        private: true,
        scripts: { test: "vitest run" },
        dependencies: { express: "5.2.1" },
        devDependencies: { vitest: "4.1.10" },
      })}\n`,
    );

    writePackagedManifest(root);

    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "convo-caddy",
      productName: "Convo Caddy",
      version: "0.1.0",
      private: true,
      type: "module",
      main: "dist/desktop/main.mjs",
      dependencies: { express: "5.2.1" },
      author: "Frameyard",
      license: "MIT",
    });
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("devDependencies");
  });

  it("rejects credential files, participant data, and secret-looking content", () => {
    const root = createTemporaryDirectory();
    const safeRoot = path.join(root, "safe");
    writeRequiredPackageFiles(safeRoot);
    writeFileSync(
      path.join(safeRoot, "dist", "desktop", "main.mjs"),
      "const label = 'CONVO_CADDY_RECALL_API_KEY';\n",
    );
    expect(() => assertSafePackagedFiles(safeRoot)).not.toThrow();

    const envRoot = path.join(root, "env");
    writeRequiredPackageFiles(envRoot);
    writeFileSync(path.join(envRoot, ".env"), "TOKEN=real-secret\n");
    expect(() => assertSafePackagedFiles(envRoot)).toThrow(
      "Disallowed packaged path: .env",
    );

    const participantRoot = path.join(root, "participant");
    writeRequiredPackageFiles(participantRoot);
    writeFileSync(
      path.join(participantRoot, "dist", "desktop", "main.mjs"),
      'const leaked = "whsec_abcdefghijklmnopqrstuvwxyz012345";\n',
    );
    expect(() => assertSafePackagedFiles(participantRoot)).toThrow(
      "Secret-like content",
    );

    const nestedSecretRoot = path.join(root, "nested-secret");
    writeRequiredPackageFiles(nestedSecretRoot);
    const nestedSecret = path.join(
      nestedSecretRoot,
      "node_modules",
      "express",
      "fixtures",
      "participant.json",
    );
    mkdirSync(path.dirname(nestedSecret), { recursive: true });
    writeFileSync(
      nestedSecret,
      'CONVO_CADDY_HERMES_API_KEY="packaged-secret-value"\n',
    );
    expect(() => assertSafePackagedFiles(nestedSecretRoot)).toThrow(
      "Secret-like content",
    );
  });

  it("rejects dependency roots outside the production closure", () => {
    const root = createTemporaryDirectory();
    const stage = createTemporaryDirectory();
    writeRequiredPackageFiles(root);
    for (const dependency of ["express", "zod", "unexpected-dev-tool"]) {
      const manifest = path.join(
        root,
        "node_modules",
        dependency,
        "package.json",
      );
      mkdirSync(path.dirname(manifest), { recursive: true });
      writeFileSync(
        manifest,
        `${JSON.stringify({ name: dependency, version: "1.0.0" })}\n`,
      );
    }
    for (const dependency of ["express", "zod"]) {
      mkdirSync(path.join(stage, dependency), { recursive: true });
    }
    expect(() => assertProductionDependencyClosure(root, stage)).toThrow(
      "unexpected-dev-tool",
    );
  });
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "convo-caddy-package-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeRequiredPackageFiles(root: string): void {
  for (const relative of PACKAGE_REQUIRED_PATHS) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, relative === "package.json" ? "{}\n" : "fixture\n");
  }
}
