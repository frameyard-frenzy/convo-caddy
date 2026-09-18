import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn((value: unknown) => value),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}));
vi.mock("electron", () => ({
  Menu: native,
  app: { name: "Convo Caddy" },
  dialog: { showMessageBox: native.showMessageBox },
  shell: { openPath: vi.fn() },
}));
import { installDesktopMenu } from "../../src/desktop/menu.js";
it("routes exactly one Move workspace action through the native Workspace menu and surfaces failure", async () => {
  const moveWorkspace = vi.fn(async () => {
    throw new Error("Finish capture first");
  });
  installDesktopMenu({
    controller: { moveWorkspace } as never,
    paths: {} as never,
    logger: {} as never,
  });
  const menu = native.buildFromTemplate.mock.calls[0]?.[0] as Array<{
    label: string;
    submenu: Array<{ label: string; click: () => void }>;
  }>;
  const workspace = menu.find((item) => item.label === "Workspace")!;
  const action = workspace.submenu.filter(
    (item) => item.label === "Move workspace…",
  );
  expect(action).toHaveLength(1);
  action[0]!.click();
  await vi.waitFor(() =>
    expect(native.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "Finish capture first" }),
    ),
  );
  expect(moveWorkspace).toHaveBeenCalledOnce();
});
it("native Quit menu and Cmd+Q invoke the serialized quit controller", () => {
  const requestQuit = vi.fn(async () => "blocked");
  installDesktopMenu({
    controller: { requestQuit } as never,
    paths: {} as never,
    logger: {} as never,
  });
  const menu = native.buildFromTemplate.mock.calls.at(-1)![0] as Array<{
    submenu?: Array<{
      label?: string;
      accelerator?: string;
      click?: () => void;
    }>;
  }>;
  const quit = menu
    .flatMap((x) => x.submenu ?? [])
    .find((x) => x.label === "Quit Convo Caddy")!;
  expect(quit.accelerator).toBe("CmdOrCtrl+Q");
  quit.click!();
  expect(requestQuit).toHaveBeenCalledOnce();
});
