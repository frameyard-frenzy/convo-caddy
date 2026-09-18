import { expect, it, vi } from "vitest";
import { createWorkspaceDialogPort } from "../../src/desktop/workspace-dialog.js";
it("uses an owned native single Markdown Open panel at workspace prep with legacy compatibility", async () => {
  const owner = {};
  const showOpenDialog = vi.fn(async () => ({
    canceled: false,
    filePaths: ["/synthetic/elsewhere/interview.md"],
  }));
  const port = createWorkspaceDialogPort(owner, { showOpenDialog });
  expect(await port.choosePrep?.("/synthetic/prep")).toBe(
    "/synthetic/elsewhere/interview.md",
  );
  expect(showOpenDialog).toHaveBeenCalledWith(owner, {
    title: "Open prep",
    buttonLabel: "Open",
    defaultPath: "/synthetic/prep",
    properties: ["openFile"],
    filters: [
      { name: "Markdown prep", extensions: ["md"] },
      { name: "Legacy JSON prep", extensions: ["json"] },
    ],
    message: expect.stringContaining("Markdown"),
  });
  showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await port.choosePrep?.("/synthetic/prep")).toBeNull();
});
it("preserves native cancellation and rejects ambiguous results or a dialog error", async () => {
  const showOpenDialog = vi.fn();
  const port = createWorkspaceDialogPort({}, { showOpenDialog });
  showOpenDialog.mockResolvedValueOnce({
    canceled: true,
    filePaths: ["/synthetic/ignored.md"],
  });
  expect(await port.choosePrep?.("/synthetic/prep")).toBeNull();
  for (const filePaths of [[], ["/synthetic/a.md", "/synthetic/b.md"]]) {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths });
    await expect(port.choosePrep?.("/synthetic/prep")).rejects.toThrow(
      "exactly one",
    );
  }
  showOpenDialog.mockRejectedValueOnce(new Error("Synthetic dialog failure"));
  await expect(port.choosePrep?.("/synthetic/prep")).rejects.toThrow(
    "Synthetic dialog failure",
  );
});
