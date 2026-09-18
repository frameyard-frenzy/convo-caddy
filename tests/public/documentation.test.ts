import { expect, it } from "vitest";
import {
  assertDocumentationReferences,
  verifyPublicTree,
} from "../../scripts/verify-public-tree.js";
it("resolves current clone documentation links, commands and configuration files", () => {
  expect(() => assertDocumentationReferences(process.cwd())).not.toThrow();
});

it("checks all committed source, including collaboration and hidden files", () => {
  expect(verifyPublicTree(process.cwd()).files).toBeGreaterThan(0);
});
