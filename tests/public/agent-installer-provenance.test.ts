import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";
const guide = readFileSync("docs/hermes-owner-handoff.md", "utf8");
const blocks = [...guide.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(
  (m) => m[1] ?? "",
);
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function shell(command: string, home: string) {
  return spawnSync("/bin/bash", ["-c", command], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      HERMES_SSH_TARGET: "synthetic@100.90.80.70",
    },
    cwd: home,
    encoding: "utf8",
  });
}
describe("installer-only agent provenance command chain", () => {
  it("acquires every verification input before either host executes and leaves people unchanged", () => {
    expect(guide).not.toContain("source checkout");
    expect(guide).not.toContain("git rev-parse");
    expect(guide).not.toContain("REVIEWED-COMMIT");
    expect(guide).toContain("sourceSha");
    expect(guide).toContain("not independent proof");
    expect(guide.indexOf("python3 --version")).toBeLessThan(
      guide.indexOf("# Export public installer resources"),
    );
    expect(guide.indexOf("Transfer checksum SHA256:")).toBeLessThan(
      guide.indexOf("EXPECTED-CHECKSUM-SHA256"),
    );
    for (const location of ["On the interview laptop"]) {
      const section = guide.split(`## ${location}`)[1]?.split("\n## ")[0] ?? "";
      expect(section).toContain("python3 --version");
      expect(section).toContain("shasum -a 256 -c");
      expect(section).toContain("python3 -I -S");
      expect(section).toContain("metadata");
    }
  });
  it.each([
    "valid",
    "missing-manifest",
    "dirty",
    "bad-sha",
    "tampered-manifest",
    "missing-helper",
    "existing-output",
  ])("extracts only verified public installer bytes: %s", async (scenario) => {
    const root = mkdtempSync(path.join(tmpdir(), "caddy-public-provenance-"));
    try {
      const source = path.join(root, "synthetic-asar-source");
      const resources = path.join(root, "Resources");
      const manifestDir = path.join(source, "dist/desktop");
      mkdirSync(manifestDir, { recursive: true });
      mkdirSync(resources);
      mkdirSync(path.join(root, "Downloads"));
      if (scenario !== "missing-manifest")
        writeFileSync(
          path.join(manifestDir, "build-provenance.json"),
          JSON.stringify({
            schemaVersion: 1,
            sourceSha: scenario === "bad-sha" ? "invalid" : "a".repeat(40),
            sourceClean: scenario !== "dirty",
          }),
        );
      await createPackage(source, path.join(resources, "app.asar"));
      if (scenario === "tampered-manifest") {
        const asar = readFileSync(path.join(resources, "app.asar"));
        const position = asar.lastIndexOf(Buffer.from('"sourceClean":true'));
        expect(position).toBeGreaterThan(0);
        asar[position + 14] = "f".charCodeAt(0);
        writeFileSync(path.join(resources, "app.asar"), asar);
      }
      const helper = readFileSync("scripts/acquire-hermes.py");
      if (scenario !== "missing-helper")
        writeFileSync(path.join(resources, "acquire-hermes.py"), helper);
      const destination = path.join(root, "Downloads/Caddy-public-helper");
      if (scenario === "existing-output") mkdirSync(destination);
      const original = blocks.find((b) =>
        b.startsWith("# Export public installer resources"),
      );
      expect(original).toBeDefined();
      if (!original) throw Error("Installer export command missing");
      const command = original.replace(
        '"/Applications/Convo Caddy.app/Contents/Resources"',
        quote(resources),
      );
      const result = shell(command, root);
      expect(result.status).toBe(scenario === "valid" ? 0 : 1);
      if (scenario === "valid") {
        expect(
          readFileSync(path.join(destination, "acquire-hermes.py")),
        ).toEqual(helper);
        expect(result.stdout).toContain("Source commit: " + "a".repeat(40));
        expect(result.stdout).toContain(
          "Transfer checksum SHA256: " +
            digest(readFileSync(path.join(destination, "SHA256SUMS"))),
        );
      } else
        expect(existsSync(path.join(destination, "acquire-hermes.py"))).toBe(
          false,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    "valid",
    "missing",
    "tampered-helper",
    "tampered-provenance",
    "tampered-checksums",
    "wrong-receipt",
  ])(
    "gates actual metadata commands on transferred public checksums: %s",
    (scenario) => {
      const root = mkdtempSync(path.join(tmpdir(), "caddy-public-transfer-"));
      try {
        const folder = path.join(root, "Downloads/Caddy-public-helper");
        mkdirSync(folder, { recursive: true });
        const helper = Buffer.from('print("synthetic metadata executed")\n');
        writeFileSync(path.join(folder, "acquire-hermes.py"), helper);
        const manifest = Buffer.from(
          '{"schemaVersion":1,"sourceSha":"' +
            "a".repeat(40) +
            '","sourceClean":true}',
        );
        writeFileSync(path.join(folder, "build-provenance.json"), manifest);
        const sums = Buffer.from(
          `${digest(helper)}  acquire-hermes.py\n${digest(manifest)}  build-provenance.json\n`,
        );
        writeFileSync(path.join(folder, "SHA256SUMS"), sums);
        if (scenario === "missing")
          rmSync(path.join(folder, "build-provenance.json"));
        if (scenario === "tampered-helper")
          writeFileSync(
            path.join(folder, "acquire-hermes.py"),
            'raise RuntimeError("unverified source executed")',
          );
        if (scenario === "tampered-provenance")
          writeFileSync(path.join(folder, "build-provenance.json"), "{}");
        if (scenario === "tampered-checksums")
          writeFileSync(path.join(folder, "SHA256SUMS"), "tampered");
        const commands = blocks.filter((b) =>
          b.startsWith("# Verify public files and run"),
        );
        expect(commands).toHaveLength(2);
        for (const original of commands) {
          const result = shell(
            original.replaceAll(
              "EXPECTED-CHECKSUM-SHA256",
              scenario === "wrong-receipt" ? "0".repeat(64) : digest(sums),
            ),
            root,
          );
          expect(result.status === 0).toBe(scenario === "valid");
          expect(result.stdout.includes("synthetic metadata executed")).toBe(
            scenario === "valid",
          );
          expect(result.stderr).not.toContain("unverified source executed");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

it("matches existing package resource producers without inventing a manifest field", () => {
  const builder = readFileSync("scripts/build-desktop.ts", "utf8");
  expect(builder).toContain(
    'path.join(outputDirectory, "build-provenance.json")',
  );
  expect(builder).toContain(
    'schemaVersion: 1, sourceSha, sourceClean: sourceStatus === ""',
  );
  expect(readFileSync("forge.config.ts", "utf8")).toContain(
    'path.join(projectRoot, "scripts/acquire-hermes.py")',
  );
  expect(guide).toContain("it does not contain a helper hash");
  expect(guide).not.toContain("curl ");
});
