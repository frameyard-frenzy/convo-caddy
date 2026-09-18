import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPublicReleaseManifest,
  notarizeStandaloneApp,
  prepareReleaseCandidate,
  resolveSigningMode,
  systemRunner,
} from "../../scripts/lib/release-manifest.js";

describe("strict macOS release preparation", () => {
  it("retains signing metadata written to stderr and rejects subprocess failure", () => {
    const root = fixtureArtifacts();
    const script = path.join(root, "metadata.cjs");
    writeFileSync(script, 'process.stderr.write("TeamIdentifier=TEAM123\\n");');
    expect(systemRunner(process.execPath, [script])).toContain(
      "TeamIdentifier=TEAM123",
    );
    writeFileSync(
      script,
      'process.stderr.write("secret fixture diagnostic"); process.exit(9);',
    );
    expect(() => systemRunner(process.execPath, [script])).toThrow();
  });

  it("never falls back from release-signed to local ad hoc", () => {
    expect(() =>
      resolveSigningMode({ CONVO_CADDY_SIGNING_MODE: "release-signed" }),
    ).toThrow(/identity/i);
    expect(() =>
      resolveSigningMode({
        CONVO_CADDY_SIGNING_MODE: "release-signed",
        CONVO_CADDY_CODESIGN_IDENTITY: "Apple Development: Wrong",
        CONVO_CADDY_SIGNING_TEAM: "TEAM123",
        CONVO_CADDY_NOTARY_KEYCHAIN_PROFILE: "notary",
      }),
    ).toThrow(/Developer ID Application/i);
    expect(resolveSigningMode({})).toEqual({ mode: "local-ad-hoc" });
  });

  it("verifies identity/team, signs inside-out, notarizes and staples before hashing", () => {
    const root = fixtureArtifacts();
    const calls: Array<[string, string[]]> = [];
    const runner = (command: string, args: string[]) => {
      calls.push([command, args]);
      if (command.endsWith("security"))
        return '  1) ABC "Developer ID Application: Frameyard (TEAM123)"\n';
      if (args.includes("-dv"))
        return "TeamIdentifier=TEAM123\nAuthority=Developer ID Application: Frameyard (TEAM123)\nflags=0x10000(runtime)\n";
      return "ok\n";
    };
    const result = prepareReleaseCandidate({
      root,
      identity: "Developer ID Application: Frameyard (TEAM123)",
      team: "TEAM123",
      notaryProfile: "frameyard-notary",
      runner,
    });
    const commands = calls.map(
      ([command, args]) => `${path.basename(command)} ${args.join(" ")}`,
    );
    expect(commands[0]).toMatch(/^security find-identity/);
    expect(
      commands.filter((line) => line.startsWith("codesign --verify")).length,
    ).toBeGreaterThan(2);
    expect(commands.join("\n")).toContain("notarytool submit");
    expect(commands.join("\n")).toContain("stapler staple");
    expect(commands.at(-1)).toContain("spctl --assess --type open");
    expect(result.signingTeam).toBe("TEAM123");
    expect(result.notarization).toBe("accepted-and-stapled");
  });

  it("signs and verifies the DMG before notarization and hashes post-staple bytes", () => {
    const root = fixtureArtifacts();
    const calls: string[][] = [];
    const dmg = path.join(root, "out/make/Convo Caddy-0.2.0-alpha.1-arm64.dmg");
    const result = prepareReleaseCandidate({
      root,
      identity: "Developer ID Application: Frameyard (TEAM123)",
      team: "TEAM123",
      notaryProfile: "fixture",
      runner: (command, args) => {
        calls.push([command, ...args]);
        if (command.endsWith("security"))
          return '"Developer ID Application: Frameyard (TEAM123)"';
        if (args.includes("-dv"))
          return "TeamIdentifier=TEAM123\nAuthority=Developer ID Application: Frameyard (TEAM123)\nCodeDirectory flags=0x10000(runtime)";
        if (args[0] === "stapler" && args[1] === "staple" && args[2] === dmg)
          writeFileSync(dmg, "stapled");
        return "ok";
      },
    });
    const sign = calls.findIndex(
      (c) => c.includes("--sign") && c.includes(dmg),
    );
    const verify = calls.findIndex((c) => c.includes("-dv") && c.includes(dmg));
    const submit = calls.findIndex(
      (c) => c.includes("submit") && c.includes(dmg),
    );
    expect(sign).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(sign);
    expect(submit).toBeGreaterThan(verify);
    expect(result.sha256).toBe(
      createHash("sha256").update("stapled").digest("hex"),
    );
  });

  it.each(["missing-runtime", "wrong-dmg-team"])(
    "rejects %s before submission",
    (failure) => {
      const root = fixtureArtifacts();
      const calls: string[][] = [];
      expect(() =>
        prepareReleaseCandidate({
          root,
          identity: "Developer ID Application: Frameyard (TEAM123)",
          team: "TEAM123",
          notaryProfile: "fixture",
          runner: (command, args) => {
            calls.push(args);
            if (command.endsWith("security"))
              return '"Developer ID Application: Frameyard (TEAM123)"';
            if (args.includes("-dv")) {
              const wrong =
                failure === "wrong-dmg-team" && args.at(-1)?.endsWith(".dmg");
              return `TeamIdentifier=${wrong ? "OTHER123" : "TEAM123"}\nAuthority=Developer ID Application: Frameyard (TEAM123)\n${failure === "missing-runtime" ? "flags=0x0(none)" : "flags=0x10000(runtime)"}`;
            }
            return "ok";
          },
        }),
      ).toThrow(/runtime|team/i);
      expect(calls.some((c) => c.includes("submit"))).toBe(false);
    },
  );

  it.each(["wrong-team", "missing-runtime"])(
    "rejects nested code with %s before notarization",
    (failure) => {
      const root = fixtureArtifacts();
      const submissions: string[][] = [];
      expect(() =>
        prepareReleaseCandidate({
          root,
          identity: "Developer ID Application: Frameyard (TEAM123)",
          team: "TEAM123",
          notaryProfile: "fixture",
          runner: (command, args) => {
            if (args.includes("submit")) submissions.push(args);
            if (command.endsWith("security"))
              return '"Developer ID Application: Frameyard (TEAM123)"';
            if (args.includes("-dv")) {
              const target = args.at(-1) ?? "";
              const nested = target.endsWith("native.node");
              return [
                `TeamIdentifier=${nested && failure === "wrong-team" ? "OTHER123" : "TEAM123"}`,
                "Authority=Developer ID Application: Frameyard (TEAM123)",
                nested && failure === "missing-runtime"
                  ? "flags=0x0(none)"
                  : "flags=0x10000(runtime)",
              ].join("\n");
            }
            return "ok";
          },
        }),
      ).toThrow(/team|runtime/i);
      expect(submissions).toEqual([]);
    },
  );

  it("archives, notarizes, and staples the standalone uninstaller before DMG creation", () => {
    const root = fixtureArtifacts();
    const calls: string[] = [];
    notarizeStandaloneApp({
      app: path.join(root, "Uninstall Convo Caddy.app"),
      notaryProfile: "fixture-profile",
      runner: (command, args) => {
        calls.push(`${path.basename(command)} ${args.join(" ")}`);
        return "ok";
      },
    });
    expect(calls[0]).toMatch(/^ditto -c -k --keepParent/);
    expect(calls[1]).toContain("notarytool submit");
    expect(calls[2]).toContain("stapler staple");
    expect(calls[3]).toContain("stapler validate");
  });

  it("propagates signing or notarization rejection and produces no success result", () => {
    const root = fixtureArtifacts();
    const runner = (command: string, args: string[]) => {
      if (command.endsWith("security"))
        return '"Developer ID Application: Frameyard (TEAM123)"';
      if (args.includes("-dv"))
        return "TeamIdentifier=TEAM123\nAuthority=Developer ID Application: Frameyard (TEAM123)\nflags=0x10000(runtime)";
      if (args.includes("submit")) throw new Error("notarization rejected");
      return "ok";
    };
    expect(() =>
      prepareReleaseCandidate({
        root,
        identity: "Developer ID Application: Frameyard (TEAM123)",
        team: "TEAM123",
        notaryProfile: "fixture",
        runner,
      }),
    ).toThrow(/notarization rejected/);
  });
});

describe("public release manifest", () => {
  it("records clean-export provenance and artifact hashes without private metadata", () => {
    const root = fixtureArtifacts();
    const manifest = createPublicReleaseManifest({
      root,
      version: "0.2.0-alpha.1",
      cleanExportSha: "a".repeat(40),
      signingTeam: "TEAM123",
      notarization: "accepted-and-stapled",
      toolVersions: {
        node: "24.15.0",
        pnpm: "11.19.0",
        swift: "6.2.4",
        xcode: "16.4",
      },
    });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.source.cleanExportSha).toBe("a".repeat(40));
    expect(manifest.platform).toEqual({
      architecture: "arm64",
      minimumMacOS: "14.0",
    });
    expect(manifest.artifacts.every((a) => !path.isAbsolute(a.filename))).toBe(
      true,
    );
    expect(manifest.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(/profile|email|privateSource|Users\//i);
  });

  it("rejects invalid public provenance and versions", () => {
    const root = fixtureArtifacts();
    expect(() =>
      createPublicReleaseManifest({
        root,
        version: "latest",
        cleanExportSha: "private",
        signingTeam: "TEAM123",
        notarization: "accepted-and-stapled",
        toolVersions: { node: "24", pnpm: "11", swift: "6", xcode: "16" },
      }),
    ).toThrow();
  });

  it("rejects developer-local metadata in otherwise public fields", () => {
    const root = fixtureArtifacts();
    expect(() =>
      createPublicReleaseManifest({
        root,
        version: "0.2.0",
        cleanExportSha: "b".repeat(40),
        signingTeam: "TEAM123",
        notarization: "accepted-and-stapled",
        toolVersions: { node: ["", "Users", "example", "node"].join("/") },
      }),
    ).toThrow(/private/i);
  });
});

function fixtureArtifacts(): string {
  const root = mkdtempSync(path.join(tmpdir(), "caddy-release-"));
  for (const relative of [
    "Convo Caddy.app/Contents/Frameworks/Helper.app",
    "Convo Caddy.app/Contents/Resources/app.asar.unpacked",
    "Uninstall Convo Caddy.app/Contents/MacOS",
    "out/make/zip/darwin/arm64",
  ])
    mkdirSync(path.join(root, relative), { recursive: true });
  writeFileSync(
    path.join(root, "Convo Caddy.app/Contents/Frameworks/libElectron.dylib"),
    "framework",
  );
  writeFileSync(
    path.join(
      root,
      "Convo Caddy.app/Contents/Resources/app.asar.unpacked/native.node",
    ),
    "native",
  );
  writeFileSync(
    path.join(root, "Uninstall Convo Caddy.app/Contents/MacOS/uninstall"),
    "uninstall",
  );
  writeFileSync(
    path.join(root, "out/make/Convo Caddy-0.2.0-alpha.1-arm64.dmg"),
    "dmg",
  );
  writeFileSync(
    path.join(
      root,
      "out/make/zip/darwin/arm64/Convo Caddy-darwin-arm64-0.2.0-alpha.1.zip",
    ),
    "zip",
  );
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}
