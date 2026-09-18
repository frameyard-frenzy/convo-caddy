import { describe, expect, it, vi } from "vitest";
import { createWorkspaceDialogPort } from "../../src/desktop/workspace-dialog.js";

describe("workspace chooser", () => {
  it("uses one native directory chooser and treats cancellation as harmless", async () => {
    const showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: ["/tmp/interviews"],
    }));
    const dialog = createWorkspaceDialogPort({}, { showOpenDialog });
    await expect(
      dialog.chooseWorkspace({
        title: "Choose workspace",
        buttonLabel: "Use Workspace",
      }),
    ).resolves.toBe("/tmp/interviews");
    expect(showOpenDialog).toHaveBeenCalledOnce();
  });
});

it("explains parent-child creation and private-state exclusion in the native chooser", async () => {
  const showOpenDialog = vi.fn(async (_owner: object, _options: unknown) => ({
    canceled: true,
    filePaths: [],
  }));
  const dialog = createWorkspaceDialogPort({}, { showOpenDialog });
  await dialog.chooseWorkspace({
    title: "Choose workspace parent",
    buttonLabel: "Create Workspace Here",
  });
  expect(showOpenDialog.mock.calls[0]?.[1]).toMatchObject({
    message: expect.stringMatching(
      /Convo Caddy Workspace.*outside Application Support/i,
    ),
  });
});
