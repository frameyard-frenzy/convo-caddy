/** Discovery only. No tools/call, ambient credentials, default transport or live CLI. */
const REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"];
const VERSION = "2025-06-18";
const TOOL_NAMES = [
  "list_webhook_endpoints",
  "send_test_webhook_endpoint",
  "list_webhook_deliveries",
];
const MAX_BYTES = 262144;
type ObjectValue = Record<string, unknown>;
export type DiscoveredTool = {
  name: string;
  inputSchema: ObjectValue;
  outputSchema?: ObjectValue;
};
export type DiscoveryResult = {
  state:
    | "discovered"
    | "configuration_rejected"
    | "authentication_rejected"
    | "unavailable"
    | "protocol_rejected"
    | "tools_missing";
  tools: DiscoveredTool[];
  cleanup: "complete" | "blocked";
};
class DiscoveryError extends Error {
  constructor(readonly state: DiscoveryResult["state"]) {
    super(state);
  }
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DiscoveryError("protocol_rejected");
  return value as ObjectValue;
}

export async function discoverRecallWebhookTools(options: {
  region: string;
  key: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<DiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (
    !REGIONS.includes(options.region) ||
    !/^[\x21-\x7e]{1,4096}$/.test(options.key) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  ) {
    return { state: "configuration_rejected", tools: [], cleanup: "complete" };
  }
  const url = `https://${options.region}.recall.ai/mcp`;
  let session: string | undefined;
  let initialized = false;
  let id = 0;
  const deadline = Date.now() + timeoutMs;
  const request = async (
    method: string,
    params?: ObjectValue,
    notification = false,
    cleanup = false,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const remaining = cleanup ? 1000 : deadline - Date.now();
    if (remaining <= 0) throw new DiscoveryError("unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async () => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.key}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      if (session) headers["Mcp-Session-Id"] = session;
      if (initialized) headers["MCP-Protocol-Version"] = VERSION;
      const requestId = ++id;
      const response = await options.fetchImpl(url, {
        method: cleanup ? "DELETE" : "POST",
        redirect: "error",
        headers,
        signal: controller.signal,
        ...(cleanup
          ? {}
          : {
              body: JSON.stringify({
                jsonrpc: "2.0",
                ...(notification ? {} : { id: requestId }),
                method,
                ...(params ? { params } : {}),
              }),
            }),
      });
      try {
        if (response.status === 401 || response.status === 403)
          throw new DiscoveryError("authentication_rejected");
        if (cleanup) {
          if (!response.ok) throw new DiscoveryError("unavailable");
          return undefined;
        }
        if (!response.ok) throw new DiscoveryError("unavailable");
        const receivedSession = response.headers.get("mcp-session-id");
        if (method === "initialize" && receivedSession) {
          if (!/^[\x21-\x7e]{1,256}$/.test(receivedSession))
            throw new DiscoveryError("protocol_rejected");
          session = receivedSession;
        }
        if (notification) {
          if (response.status !== 202)
            throw new DiscoveryError("protocol_rejected");
          return undefined;
        }
        const contentType = response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim();
        if (
          contentType !== "application/json" &&
          contentType !== "text/event-stream"
        )
          throw new DiscoveryError("protocol_rejected");
        const reader = response.body?.getReader();
        if (!reader) throw new DiscoveryError("protocol_rejected");
        let bytes = 0;
        let buffer = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const parse = (text: string): unknown => {
          const rpc = object(JSON.parse(text));
          if (
            rpc.jsonrpc !== "2.0" ||
            rpc.id !== requestId ||
            !("result" in rpc) ||
            "error" in rpc
          )
            throw new DiscoveryError("protocol_rejected");
          return rpc.result;
        };
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES)
              throw new DiscoveryError("protocol_rejected");
            buffer += decoder.decode(chunk.value, { stream: true });
            if (contentType === "text/event-stream") {
              // Normalize CRLF only once complete frames are available, including split CR/LF chunks.
              while (true) {
                const match = /\r?\n\r?\n/.exec(buffer);
                if (!match) break;
                const frame = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                const data = frame
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).replace(/^ /, ""))
                  .join("\n");
                if (!data) continue;
                const rpc = object(JSON.parse(data));
                if (
                  rpc.jsonrpc === "2.0" &&
                  typeof rpc.method === "string" &&
                  !("id" in rpc)
                )
                  continue;
                return parse(data);
              }
            }
          }
          buffer += decoder.decode();
          if (contentType === "text/event-stream")
            throw new DiscoveryError("protocol_rejected");
          return parse(buffer);
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      } finally {
        if (!response.body?.locked)
          await response.body?.cancel().catch(() => undefined);
      }
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DiscoveryError("unavailable"));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  };
  let result: DiscoveryResult = {
    state: "protocol_rejected",
    tools: [],
    cleanup: "complete",
  };
  try {
    const init = object(
      await request("initialize", {
        protocolVersion: VERSION,
        capabilities: {},
        clientInfo: {
          name: "convo-caddy-discovery-experiment",
          version: "0.0.0",
        },
      }),
    );
    if (
      init.protocolVersion !== VERSION ||
      !object(init.capabilities).tools ||
      typeof object(init.serverInfo).name !== "string" ||
      typeof object(init.serverInfo).version !== "string"
    )
      throw new DiscoveryError("protocol_rejected");
    object(object(init.capabilities).tools);
    initialized = true;
    await request("notifications/initialized", undefined, true);
    const tools: DiscoveredTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const list = object(
        await request("tools/list", cursor ? { cursor } : {}),
      );
      if (!Array.isArray(list.tools) || list.tools.length > 128)
        throw new DiscoveryError("protocol_rejected");
      for (const value of list.tools) {
        const tool = object(value);
        if (
          typeof tool.name !== "string" ||
          tool.name.length > 128 ||
          names.has(tool.name)
        )
          throw new DiscoveryError("protocol_rejected");
        names.add(tool.name);
        const schema = object(tool.inputSchema);
        if (schema.type !== "object")
          throw new DiscoveryError("protocol_rejected");
        if (TOOL_NAMES.includes(tool.name))
          tools.push({
            name: tool.name,
            inputSchema: schema,
            ...(tool.outputSchema === undefined
              ? {}
              : { outputSchema: object(tool.outputSchema) }),
          });
      }
      if (list.nextCursor === undefined) {
        result = {
          state:
            tools.length === TOOL_NAMES.length ? "discovered" : "tools_missing",
          tools,
          cleanup: "complete",
        };
        break;
      }
      if (
        typeof list.nextCursor !== "string" ||
        !list.nextCursor ||
        list.nextCursor.length > 1024 ||
        cursors.has(list.nextCursor)
      )
        throw new DiscoveryError("protocol_rejected");
      cursor = list.nextCursor;
      cursors.add(cursor);
    }
  } catch (error) {
    result = {
      state: error instanceof DiscoveryError ? error.state : "unavailable",
      tools: [],
      cleanup: "complete",
    };
  } finally {
    if (session) {
      try {
        await request("", undefined, false, true);
      } catch {
        result.cleanup = "blocked";
      }
    }
  }
  return result;
}
