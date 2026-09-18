import type { NavigationPolicy } from "./window-security.js";

// Main initiates this narrow, one-way document handshake. No renderer IPC can
// quit the app, grant unload authority, or invoke a native dialog.
export interface CloseWindowPort {
  url(): string;
  generation(): number;
  evaluate(script: string): Promise<unknown>;
  choose(): Promise<"save" | "discard" | "cancel">;
  report(message: string): Promise<void>;
  close(): void;
  onClosed(listener: () => void): () => void;
  onVeto(listener: () => void): () => void;
}
export async function closeWindowForQuit(
  port: CloseWindowPort,
  policy: NavigationPolicy,
  approveClose: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  const documentUrl = port.url();
  const generation = port.generation();
  const current = () =>
    policy.allows(documentUrl) &&
    port.url() === documentUrl &&
    port.generation() === generation;
  const invoke = async (action: string) => {
    if (!current()) throw Error("The page changed. Try Quit again.");
    const result = await port.evaluate(
      `window.caddyPrepareClose ? window.caddyPrepareClose(${JSON.stringify(action)}) : "unavailable"`,
    );
    if (!current()) throw Error("The page changed. Try Quit again.");
    return result;
  };
  let closed = false;
  try {
    let status = await invoke("status");
    if (status === "dirty") {
      const choice = await port.choose();
      if (choice === "cancel") return false;
      status = await invoke(choice);
    } else if (status === "clean") status = await invoke("clean");
    if (status !== "ready" && status !== "unavailable") {
      await port.report(
        "Your changes are still here. Finish the current edit or save, then try Quit again.",
      );
      return false;
    }
    if (!(await approveClose())) return false;
    if (!current()) throw Error("The page changed. Try Quit again.");
    closed = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Native destruction can make listener removal throw. The confirmed
        // event still settles exactly once; attempt both independent cleanups.
        for (const remove of [offClosed, offVeto]) {
          try {
            remove();
          } catch {
            /* Already destroyed native emitter. */
          }
        }
        resolve(value);
      };
      const offClosed = port.onClosed(() => finish(true));
      // Never preventDefault here: Electron uses that to IGNORE the veto.
      const offVeto = port.onVeto(() => finish(false));
      timer = setTimeout(() => finish(false), 5000);
      try {
        port.close();
      } catch {
        finish(false);
      }
    });
    if (!closed)
      await port.report(
        "The page kept Convo Caddy open. Your runtime is still running; try Quit again when ready.",
      );
    return closed;
  } catch {
    await port.report(
      "Could not save or close. Your changes are still here. Check the page error, then retry Save or Quit.",
    );
    return false;
  } finally {
    if (!closed && current()) await invoke("cancel").catch(() => {});
  }
}
