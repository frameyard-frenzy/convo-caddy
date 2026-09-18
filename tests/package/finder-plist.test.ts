import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { readFinderValue } from "../../scripts/lib/finder-plist.js";

it.skipIf(process.platform !== "darwin")(
  "reads native Finder fields without losing the binary background alias",
  () => {
    const bytes = execFileSync(
      "/usr/bin/plutil",
      ["-convert", "binary1", "-o", "-", "-"],
      {
        input: `<?xml version="1.0"?><plist version="1.0"><dict><key>backgroundImageAlias</key><data>Zml4dHVyZQ==</data><key>iconSize</key><real>72</real><key>ShowToolbar</key><false/></dict></plist>`,
      },
    );
    expect(() =>
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
        input: bytes,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).toThrow();
    expect(readFinderValue(bytes, "backgroundImageAlias")).toBe("Zml4dHVyZQ==");
    expect(Number(readFinderValue(bytes, "iconSize"))).toBe(72);
    expect(readFinderValue(bytes, "ShowToolbar")).toBe("false");
    expect(() => readFinderValue(bytes, "missing")).toThrow();
  },
);
