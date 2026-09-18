export interface WorkspaceDialogPort {
  confirmMove?(source: string, destination: string): Promise<boolean>;
  showError?(message: string): Promise<void>;
  choosePrep?(directory: string): Promise<string | null>;
  chooseWorkspace(input: {
    title: string;
    buttonLabel: string;
  }): Promise<string | null>;
}
export interface NativeWorkspaceDialogAdapter {
  showMessageBox?(
    owner: object,
    options: {
      type: "error" | "question";
      message: string;
      detail: string;
      buttons?: string[];
      defaultId?: number;
      cancelId?: number;
    },
  ): Promise<unknown>;
  showOpenDialog(
    owner: object,
    options: {
      title: string;
      buttonLabel: string;
      properties: ["openDirectory", "createDirectory"] | ["openFile"];
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      message: string;
    },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}
export function createWorkspaceDialogPort(
  owner: object,
  native: NativeWorkspaceDialogAdapter,
): WorkspaceDialogPort {
  return {
    confirmMove: async (source, destination) => {
      const result = await native.showMessageBox?.(owner, {
        type: "question",
        message: "Move the entire workspace?",
        detail: `From: ${source}\nTo: ${destination}\n\nAll files, including files you added, move together. Caddy verifies the copy before retiring the original. Future finished conversations use the new location.`,
        buttons: ["Cancel", "Move Workspace"],
        defaultId: 0,
        cancelId: 0,
      });
      return (
        typeof result === "object" &&
        result !== null &&
        "response" in result &&
        result.response === 1
      );
    },
    choosePrep: async (directory) => {
      const result = await native.showOpenDialog(owner, {
        title: "Open prep",
        buttonLabel: "Open",
        defaultPath: directory,
        properties: ["openFile"],
        filters: [
          { name: "Markdown prep", extensions: ["md"] },
          { name: "Legacy JSON prep", extensions: ["json"] },
        ],
        message:
          "Choose a Markdown prep file. Before the interview starts, Save updates this file and Caddy’s working copy.",
      });
      if (result.canceled) return null;
      if (result.filePaths.length !== 1)
        throw new Error("Choose exactly one prep file.");
      return result.filePaths[0] ?? null;
    },
    showError: async (message) => {
      await native.showMessageBox?.(owner, {
        type: "error",
        message: "Workspace operation needs attention",
        detail: message,
      });
    },
    chooseWorkspace: async (input) => {
      const result = await native.showOpenDialog(owner, {
        ...input,
        message:
          "Select a parent folder. Caddy creates Convo Caddy Workspace inside it, or reuses its own verified workspace. Keep it outside Application Support and private app state.",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled) return null;
      if (result.filePaths.length !== 1)
        throw new Error("Workspace chooser must return exactly one folder.");
      return result.filePaths[0] ?? null;
    },
  };
}
