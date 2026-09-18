import type { DesktopPaths } from "../server/desktop/paths.js";
import { loadDesktopPreferences } from "../server/desktop/preferences.js";
import {
  moveWorkspace,
  hasPendingWorkspaceMove,
  WORKSPACE_MOVE_RECOVERY_MESSAGE,
  workspaceMoveDestination,
} from "../server/desktop/workspace-move.js";
import type { SessionService } from "../server/session-service.js";
import type { WorkspaceDialogPort } from "./workspace-dialog.js";

export async function relocateWorkspace(
  paths: DesktopPaths,
  service: SessionService,
  dialog: WorkspaceDialogPort,
): Promise<void> {
  const release = service.beginWorkspaceMove();
  try {
    const source = service.getWorkspaceOverview()?.root;
    if (!source) throw new Error("No workspace is configured.");
    const parent = await dialog.chooseWorkspace({
      title: "Move workspace — choose a destination parent",
      buttonLabel: "Choose Destination",
    });
    if (parent === null) return;
    const destination = workspaceMoveDestination(paths, source, parent);
    if (!dialog.confirmMove || !(await dialog.confirmMove(source, destination)))
      return;
    try {
      moveWorkspace(paths, parent);
    } finally {
      // The journal may have switched durable authority before source retirement
      // failed. Keep the running app on that same authoritative root.
      const current = loadDesktopPreferences(paths).workspaceRoot;
      if (current && current !== source) service.rebaseWorkspace(current);
    }
  } catch (error) {
    if (hasPendingWorkspaceMove(paths))
      throw new Error(WORKSPACE_MOVE_RECOVERY_MESSAGE, { cause: error });
    throw error;
  } finally {
    // A journal still owns both inventories even if authority already switched.
    // Only startup recovery may release this barrier after completing the move.
    release(
      hasPendingWorkspaceMove(paths)
        ? WORKSPACE_MOVE_RECOVERY_MESSAGE
        : undefined,
    );
  }
}
