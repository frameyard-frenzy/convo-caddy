// Subprocess fixture only: production entry point has no transport override option.
import { writeFileSync } from "node:fs";
import { runDiscoveryCommand } from "../../src/server/desktop/recall-schema-discovery.js";
const [scenario, reportPath, ...args] = process.argv.slice(2);
const calls: string[] = [];
let permitted = true;
const fetchImpl: typeof fetch = async (url, init) => {
  const rpc = init?.body ? JSON.parse(String(init.body)) : undefined;
  const method = rpc?.method ?? init?.method;
  calls.push(method);
  permitted &&=
    url === "https://us-west-2.recall.ai/mcp" &&
    init?.redirect === "error" &&
    [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "DELETE",
    ].includes(method);
  if (init?.method === "DELETE")
    return new Response(null, {
      status: scenario === "cleanup-failed" ? 405 : 204,
    });
  if (scenario === "disconnect")
    throw new Error("SYNTHETIC-DISCOVERY-SENTINEL");
  if (scenario === "error")
    return new Response("SYNTHETIC-DISCOVERY-SENTINEL", { status: 401 });
  if (rpc.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (scenario === "cancel-network" && rpc.method === "tools/list") {
    process.stderr.write("FIXTURE_WAITING\n");
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("synthetic abort")),
        { once: true },
      ),
    );
  }
  const result =
    rpc.method === "initialize"
      ? {
          protocolVersion:
            scenario === "unsupported" ? "unsupported" : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        }
      : {
          tools: [
            "list_webhook_endpoints",
            "send_test_webhook_endpoint",
            "list_webhook_deliveries",
            "create_webhook_endpoint",
          ].map((name) => ({
            name,
            description: "SYNTHETIC-DISCOVERY-SENTINEL",
            inputSchema: {
              type: "object",
              properties: {
                session: {
                  const: "PRIVATE-SESSION-ID",
                  ...(scenario === "schema-bound"
                    ? { pattern: "x".repeat(3000) }
                    : {}),
                },
                api_key: {
                  type: "string",
                  default: "SYNTHETIC-DISCOVERY-SENTINEL",
                },
              },
              description: "\u001b[31mSYNTHETIC-DISCOVERY-SENTINEL",
            },
          })),
        };
  return Response.json(
    { jsonrpc: "2.0", id: rpc.id, result },
    { headers: { "Mcp-Session-Id": "PRIVATE-SESSION-ID" } },
  );
};
process.exitCode = await runDiscoveryCommand(args, {
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
  fetchImpl,
});
writeFileSync(reportPath, JSON.stringify({ calls, permitted }));
