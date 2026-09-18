import { expect, it, vi } from "vitest";
import {
  type CloseWindowPort,
  closeWindowForQuit,
} from "../../src/desktop/close-window.js";
import { NavigationPolicy } from "../../src/desktop/window-security.js";

function fixture() {
  const policy = new NavigationPolicy();
  policy.allow("http://127.0.0.1:4999");
  let closed = () => {},
    veto = () => {};
  const port: CloseWindowPort = {
    url: () => "http://127.0.0.1:4999/",
    generation: () => 0,
    evaluate: vi.fn(async (script) =>
      script.includes('"status"') ? "dirty" : "ready",
    ),
    choose: vi.fn(async () => "cancel" as const),
    report: vi.fn(async () => {}),
    close: vi.fn(() => closed()),
    onClosed: (listener) => {
      closed = listener;
      return () => {
        closed = () => {};
      };
    },
    onVeto: (listener) => {
      veto = listener;
      return () => {
        veto = () => {};
      };
    },
  };
  return { port, policy, veto: () => veto() };
}
it("cancel and thrown save preserve window and allow a new decision", async () => {
  const f = fixture();
  expect(await closeWindowForQuit(f.port, f.policy)).toBe(false);
  expect(f.port.close).not.toHaveBeenCalled();
  vi.mocked(f.port.choose).mockResolvedValue("save");
  vi.mocked(f.port.evaluate).mockImplementation(async (script) => {
    if (script.includes('"save"')) throw Error("synthetic failure");
    return "dirty";
  });
  expect(await closeWindowForQuit(f.port, f.policy)).toBe(false);
  expect(f.port.close).not.toHaveBeenCalled();
  vi.mocked(f.port.evaluate).mockResolvedValue("ready");
  expect(await closeWindowForQuit(f.port, f.policy)).toBe(true);
});
it("an unknown document's unload veto is respected without force bypass", async () => {
  const f = fixture();
  vi.mocked(f.port.evaluate).mockResolvedValue("unavailable");
  vi.mocked(f.port.close).mockImplementation(f.veto);
  expect(await closeWindowForQuit(f.port, f.policy)).toBe(false);
  expect(f.port.report).toHaveBeenCalled();
});
it.each(["origin", "same-url-navigation"])(
  "rejects changed %s after native choice",
  async (kind) => {
    const f = fixture();
    let generation = 0;
    f.port.generation = () => generation;
    vi.mocked(f.port.choose).mockImplementation(async () => {
      if (kind === "origin") f.port.url = () => "https://example.invalid";
      else generation++;
      return "discard";
    });
    expect(await closeWindowForQuit(f.port, f.policy)).toBe(false);
    expect(f.port.close).not.toHaveBeenCalled();
    expect(f.port.evaluate).toHaveBeenCalledTimes(1);
  },
);
it("cannot execute renderer handshake at an unapproved origin", async () => {
  const f = fixture();
  f.port.url = () => "http://127.0.0.1:4998/";
  expect(await closeWindowForQuit(f.port, f.policy)).toBe(false);
  expect(f.port.evaluate).not.toHaveBeenCalled();
  expect(f.port.close).not.toHaveBeenCalled();
});

it("cleanup exceptions and duplicate native events cannot strand or change settlement", async () => {
  const f = fixture();
  vi.mocked(f.port.choose).mockResolvedValue("discard");
  let closed = () => {},
    veto = () => {};
  const offClosed = vi.fn(() => {
    throw Error("destroyed window cleanup");
  });
  const offVeto = vi.fn(() => {
    throw Error("destroyed contents cleanup");
  });
  f.port.onClosed = (listener) => {
    closed = listener;
    return offClosed;
  };
  f.port.onVeto = (listener) => {
    veto = listener;
    return offVeto;
  };
  vi.mocked(f.port.close).mockImplementation(() => {});
  const result = closeWindowForQuit(f.port, f.policy);
  await vi.waitFor(() => expect(f.port.close).toHaveBeenCalledOnce());
  expect(() => {
    closed();
    veto();
    closed();
  }).not.toThrow();
  expect(await result).toBe(true);
  expect(offClosed).toHaveBeenCalledOnce();
  expect(offVeto).toHaveBeenCalledOnce();
  expect(f.port.report).not.toHaveBeenCalled();
});
