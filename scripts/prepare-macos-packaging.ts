import { ensureMacosPackagingTool } from "./lib/macos-package-tooling.js";

const result = ensureMacosPackagingTool();
console.log(
  result === "rebuilt"
    ? "Rebuilt and verified the macOS DMG native dependency."
    : "Verified the macOS DMG native dependency.",
);
