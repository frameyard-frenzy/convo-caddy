import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireMaintenanceLock } from "../../src/desktop/maintenance-lock.js";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  }),
);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cc-lock-"));
  roots.push(root);
  return path.join(root, "control", "lifecycle.lock");
}

describe("Electron main-process maintenance lock", () => {
  it("acquires before normal startup ownership and releases only explicitly", () => {
    const file = fixture(),
      acquire = vi.fn((target: string) => {
        writeFileSync(target, "marker", { mode: 0o600 });
        return true;
      }),
      release = vi.fn();
    const handle = acquireMaintenanceLock({
      file,
      loadNative: () => ({ acquire, release }),
    });
    expect(acquire).toHaveBeenCalledWith(file);
    expect(readFileSync(file, "utf8")).toBe("marker");
    expect(release).not.toHaveBeenCalled();
    handle.release();
    handle.release();
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects a public or aliased marker after acquisition", () => {
    for (const alias of [false, true]) {
      const file = fixture(),
        release = vi.fn();
      expect(() =>
        acquireMaintenanceLock({
          file,
          loadNative: () => ({
            acquire(target) {
              if (alias) {
                writeFileSync(`${target}.actual`, "", { mode: 0o600 });
                symlinkSync(`${target}.actual`, target);
              } else writeFileSync(target, "", { mode: 0o644 });
              return true;
            },
            release,
          }),
        }),
      ).toThrow();
      expect(release).toHaveBeenCalledOnce();
    }
  });
  it("fails closed when addon load or acquisition fails", () => {
    const file = fixture();
    expect(() =>
      acquireMaintenanceLock({
        file,
        loadNative: () => {
          throw new Error("addon unavailable");
        },
      }),
    ).toThrow("addon unavailable");
    expect(() =>
      acquireMaintenanceLock({
        file,
        loadNative: () => ({ acquire: () => false, release() {} }),
      }),
    ).toThrow("did not confirm");
  });
  it("keeps ownership independent of helper child lifetime", () => {
    const release = vi.fn();
    const file = fixture();
    const handle = acquireMaintenanceLock({
      file,
      loadNative: () => ({
        acquire: (target) => {
          writeFileSync(target, "marker", { mode: 0o600 });
          return true;
        },
        release,
      }),
    });
    const unrelatedHelperExited = true;
    expect(unrelatedHelperExited).toBe(true);
    expect(release).not.toHaveBeenCalled();
    handle.release();
  });
});
