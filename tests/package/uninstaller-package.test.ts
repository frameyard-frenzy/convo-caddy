import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("standalone uninstaller package", () => {
  it("offers a no-inventory runtime probe and binds the DMG uninstaller", () => {
    const ui = readFileSync(
      "native/uninstaller/Sources/UninstallApp/main.swift",
      "utf8",
    );
    const verifier = readFileSync("scripts/verify-package-mac.ts", "utf8");
    expect(ui.indexOf('contains("--verify-runtime")')).toBeGreaterThan(0);
    expect(ui.indexOf('contains("--verify-runtime")')).toBeLessThan(
      ui.indexOf("homeDirectoryForCurrentUser"),
    );
    expect(verifier).toContain("expectedUninstallerTree");
    expect(verifier).toContain('"--verify-runtime"');
    expect(verifier).not.toContain(
      'tell application id "com.frameyard.convocaddy" to quit',
    );
  });
  it("has independent AppKit bundle metadata and a No-default decision", () => {
    const plist = readFileSync("native/uninstaller/Info.plist", "utf8"),
      ui = readFileSync(
        "native/uninstaller/Sources/UninstallApp/main.swift",
        "utf8",
      );
    expect(plist).toContain("com.frameyard.convocaddy.uninstaller");
    expect(ui).toContain("UninstallFlow.run");
    expect(ui).toContain("NativeUninstallUI: UninstallDialogUI");
    expect(ui).toContain("Cancel");
    expect(ui).not.toContain("http://");
  });
});
