import { writeFileSync } from "node:fs";
import type { ReadStream, WriteStream } from "node:tty";
import {
  discoverRecallWebhookTools,
  type DiscoveryResult,
} from "./recall-mcp-webhook-client.js";

const REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"];
const TOOLS = [
  "list_webhook_endpoints",
  "send_test_webhook_endpoint",
  "list_webhook_deliveries",
];
const MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const CHILDREN = new Set([
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);
const LISTS = new Set(["anyOf", "allOf", "oneOf", "prefixItems"]);
const VALUES = new Set([
  "type",
  "$ref",
  "$schema",
  "required",
  "enum",
  "const",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

/** Inspection only: discard prose/defaults/examples/extensions; never evaluate schemas. */
export function sanitizedDiscoveryJson(
  result: DiscoveryResult,
  key: string,
  region: string,
  sensitiveValues: readonly string[] = [],
): string {
  let nodes = 0;
  const bound = (depth: number) => {
    if (++nodes > 4000 || depth > 16) throw new Error("schema_bound");
  };
  const literal = (value: unknown, depth: number): unknown => {
    bound(depth);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length <= 2048) return value;
    if (Array.isArray(value) && value.length <= 256)
      return value.map((v) => literal(v, depth + 1));
    throw new Error("unsupported_literal");
  };
  const schema = (value: unknown, depth: number): unknown => {
    bound(depth);
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("schema_shape");
    const out: Record<string, unknown> = Object.create(null);
    for (const [field, child] of Object.entries(value)) {
      if (MAPS.has(field)) {
        if (!child || typeof child !== "object" || Array.isArray(child))
          throw new Error("schema_map");
        const entries: Record<string, unknown> = Object.create(null);
        for (const [name, entry] of Object.entries(child)) {
          literal(name, depth + 1);
          entries[name] = schema(entry, depth + 1);
        }
        out[field] = entries;
      } else if (CHILDREN.has(field)) out[field] = schema(child, depth + 1);
      else if (LISTS.has(field)) {
        if (!Array.isArray(child) || child.length > 256)
          throw new Error("schema_list");
        out[field] = child.map((entry) => schema(entry, depth + 1));
      } else if (VALUES.has(field)) out[field] = literal(child, depth + 1);
    }
    return out;
  };
  // Redact decoded strings and names, including any escaped key reflection in JSON.
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      let text = value;
      let before: string;
      do {
        before = text;
        for (const secret of [key, ...sensitiveValues])
          if (secret) text = text.split(secret).join("");
      } while (text !== before);
      return text;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = Object.create(null);
      for (const [name, child] of Object.entries(value)) {
        const safeName = String(redact(name));
        if (Object.hasOwn(out, safeName))
          throw new Error("redaction_collision");
        out[safeName] = redact(child);
      }
      return out;
    }
    return value;
  };
  const encode = (value: unknown) =>
    `${JSON.stringify(redact(value), null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
  const base = {
    state: result.state,
    protocolVersion: result.protocolVersion ?? null,
    region,
    cleanup: result.cleanup,
    sanitization: "structure_only_not_an_invocation_contract",
  };
  try {
    if (result.tools.length > 3) throw new Error("tool_bound");
    const tools = result.tools
      .filter((tool) => TOOLS.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        inputSchema: schema(tool.inputSchema, 0),
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: schema(tool.outputSchema, 0) }),
      }));
    const output = encode({ ...base, tools });
    if (Buffer.byteLength(output) > 131072) throw new Error("output_bound");
    return output;
  } catch {
    return encode({ ...base, state: "sanitization_rejected", tools: [] });
  }
}

export async function runDiscoveryCommand(
  args: string[],
  ports: {
    input: ReadStream;
    output: WriteStream;
    error: WriteStream;
    fetchImpl: typeof fetch;
  },
): Promise<number> {
  const { input, output, error } = ports;
  if (
    (args.length !== 3 && args.length !== 5) ||
    args[0] !== "--discover" ||
    args[1] !== "--region" ||
    !REGIONS.includes(args[2]) ||
    (args.length === 5 &&
      (args[3] !== "--output" || !args[4] || args[4].startsWith("-")))
  ) {
    error.write(
      "Invalid discovery arguments. Use --discover --region <region> [--output <new-file>].\n",
    );
    return 2;
  }
  if (!input.isTTY || !output.isTTY || !error.isTTY) {
    error.write(
      "Discovery requires an interactive terminal; no piped keys or output.\n",
    );
    return 2;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"] as const;
  const wasRaw = input.isRaw;
  const wasPaused = input.readableFlowing !== true;
  let key = "";
  let submitted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onData: (chunk: Buffer) => void = () => undefined;
  const restore = () => {
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  };
  try {
    for (const signal of signals) process.on(signal, cancel);
    process.on("exit", restore);
    input.setRawMode(true);
    key = await new Promise<string>((resolve, reject) => {
      let entered = "";
      const fail = () => {
        entered = "";
        reject(new Error("input_cancelled"));
      };
      controller.signal.addEventListener("abort", fail, { once: true });
      timer = setTimeout(cancel, 120000);
      onData = (chunk) => {
        for (const byte of chunk) {
          if (byte === 3 || byte === 4 || byte === 26) {
            cancel();
            return;
          }
          // Keep draining without echo during discovery, including a pasted suffix.
          if (submitted) continue;
          if (byte === 13 || byte === 10) {
            if (!entered) {
              cancel();
              return;
            }
            submitted = true;
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", fail);
            resolve(entered);
            entered = "";
          } else if (byte === 127 || byte === 8) entered = entered.slice(0, -1);
          else if (byte === 21) entered = "";
          else if (byte < 33 || byte > 126 || entered.length >= 4096) {
            cancel();
            return;
          } else entered += String.fromCharCode(byte);
        }
      };
      input.on("data", onData);
      input.on("end", cancel);
      input.on("error", cancel);
      input.resume();
      error.write(
        "Discovery only; key wait 120s, network 5s + cleanup 1s. Ctrl-C/Ctrl-D cancels.\nMCP key (hidden): ",
      );
    });
    error.write("\n");
    const result = await discoverRecallWebhookTools({
      region: args[2],
      key,
      fetchImpl: ports.fetchImpl,
      signal: controller.signal,
      sanitizeTools: (tools, sensitiveValues) => {
        const safe = JSON.parse(
          sanitizedDiscoveryJson(
            { state: "discovered", cleanup: "complete", tools },
            key,
            args[2],
            sensitiveValues,
          ),
        );
        if (safe.state !== "discovered")
          throw new Error("schema_sanitization_failed");
        return safe.tools;
      },
    });
    const text = sanitizedDiscoveryJson(result, key, args[2]);
    key = "";
    if (args[4]) writeFileSync(args[4], text, { flag: "wx", mode: 0o600 });
    output.write(text);
    return JSON.parse(text).state === "discovered" &&
      result.cleanup === "complete" &&
      !controller.signal.aborted
      ? 0
      : 2;
  } catch {
    error.write(
      "\nDiscovery cancelled, input unavailable, or export refused; no raw details emitted.\n",
    );
    return 2;
  } finally {
    key = "";
    if (timer) clearTimeout(timer);
    input.off("data", onData);
    input.off("end", cancel);
    input.off("error", cancel);
    for (const signal of signals) process.off(signal, cancel);
    process.off("exit", restore);
    restore();
  }
}
