import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanMacosPackageOutputs,
  ensureMacosPackagingTool,
} from "../../scripts/lib/macos-package-tooling.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("macOS package tooling", () => {
  it("leaves an already loadable DMG native dependency unchanged", () => {
    const operations: string[] = [];
    const cleanOutputs = vi.fn(() => operations.push("clean"));
    const rebuild = vi.fn();

    expect(
      ensureMacosPackagingTool({
        platform: "darwin",
        cleanOutputs,
        isAddonLoadable: () => {
          operations.push("check");
          return true;
        },
        rebuildAddon: rebuild,
      }),
    ).toBe("ready");
    expect(cleanOutputs).toHaveBeenCalledOnce();
    expect(rebuild).not.toHaveBeenCalled();
    expect(operations).toEqual(["clean", "check"]);
  });

  it("repairs a native dependency skipped by an earlier pnpm install", () => {
    const cleanOutputs = vi.fn();
    let loadable = false;
    const rebuild = vi.fn(() => {
      loadable = true;
    });

    expect(
      ensureMacosPackagingTool({
        platform: "darwin",
        cleanOutputs,
        isAddonLoadable: () => loadable,
        rebuildAddon: rebuild,
      }),
    ).toBe("rebuilt");
    expect(cleanOutputs).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
  });

  it("removes stale package outputs before checking the native dependency", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "convo-caddy-package-output-"),
    );
    temporaryDirectories.push(root);
    const output = path.join(root, "out");
    mkdirSync(path.join(output, "make"), { recursive: true });
    writeFileSync(path.join(output, "make", "stale.dmg"), "stale");

    cleanMacosPackageOutputs(output);

    expect(existsSync(output)).toBe(false);
  });

  it("fails before Forge when the repaired native dependency is still unavailable", () => {
    const cleanOutputs = vi.fn();
    expect(() =>
      ensureMacosPackagingTool({
        platform: "darwin",
        cleanOutputs,
        isAddonLoadable: () => false,
        rebuildAddon: () => undefined,
      }),
    ).toThrow("macOS DMG native dependency is unavailable after rebuild");
    expect(cleanOutputs).toHaveBeenCalledOnce();
  });

  it("refuses to prepare the macOS package toolchain on another platform", () => {
    expect(() =>
      ensureMacosPackagingTool({
        platform: "linux",
        isAddonLoadable: () => true,
        rebuildAddon: () => undefined,
      }),
    ).toThrow("macOS package tooling can only be prepared on macOS");
  });
});
