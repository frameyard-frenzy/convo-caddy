import { connect } from "node:net";
import { z } from "zod";
import { hermesEndpointUrl, parseHermesEndpoint } from "./hermes-endpoint.js";

const hermesHealthSchema = z
  .object({
    status: z.literal("ok"),
    platform: z.literal("hermes-agent"),
    version: z.string().min(1).max(128).optional(),
  })
  .strip();

const hermesModelsSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(
      z
        .object({
          id: z.string().min(1),
          object: z.literal("model"),
          created: z.number().int().optional(),
          owned_by: z.literal("hermes"),
          permission: z.array(z.unknown()).optional(),
          root: z.string().min(1),
          parent: z.string().nullable().optional(),
        })
        .strip(),
    ),
  })
  .strip();

export type HermesIdentityRejection =
  | "health_mismatch"
  | "authentication_rejected"
  | "models_malformed"
  | "profile_not_advertised"
  | "transport_mismatch";

export type HermesIdentityResult =
  | { kind: "absent" }
  | { kind: "verified" }
  | { kind: "rejected"; reason: HermesIdentityRejection };

export type LoopbackPortProbe = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<boolean>;

export type ProbeHermesIdentityOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  probePort?: LoopbackPortProbe;
};

export type DiscoverHermesProfilesOptions = Omit<
  ProbeHermesIdentityOptions,
  "model"
>;

export type HermesProfileDiscoveryResult =
  | { kind: "absent" }
  | { kind: "advertised"; profiles: string[] }
  | {
      kind: "rejected";
      reason: Exclude<HermesIdentityRejection, "profile_not_advertised">;
    };

export async function probeHermesIdentity(
  options: ProbeHermesIdentityOptions,
): Promise<HermesIdentityResult> {
  const discovery = await discoverHermesProfiles(options);
  if (discovery.kind === "absent") {
    return discovery;
  }
  if (discovery.kind === "rejected") {
    return discovery;
  }
  return discovery.profiles.includes(options.model)
    ? { kind: "verified" }
    : { kind: "rejected", reason: "profile_not_advertised" };
}

export async function discoverHermesProfiles(
  options: DiscoverHermesProfilesOptions,
): Promise<HermesProfileDiscoveryResult> {
  const endpoint = parseLoopbackEndpoint(options.baseUrl);
  const timeoutMs = positiveInteger(options.timeoutMs, "Hermes probe timeout");
  const occupied = await (options.probePort ?? probeLoopbackPort)(
    endpoint.hostname,
    endpoint.port,
    timeoutMs,
  );
  if (!occupied) {
    return { kind: "absent" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let health: Response;
  try {
    health = await fetchImpl(hermesEndpointUrl(endpoint, "/health"), {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "rejected", reason: "transport_mismatch" };
  }
  if (!health.ok) {
    return {
      kind: "rejected",
      reason:
        health.status === 401 || health.status === 403
          ? "authentication_rejected"
          : "transport_mismatch",
    };
  }
  try {
    hermesHealthSchema.parse(await readDiscoveryJson(health));
  } catch {
    return { kind: "rejected", reason: "health_mismatch" };
  }

  let models: Response;
  try {
    models = await fetchImpl(hermesEndpointUrl(endpoint, "/v1/models"), {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "rejected", reason: "transport_mismatch" };
  }
  if (!models.ok) {
    return {
      kind: "rejected",
      reason:
        models.status === 401 || models.status === 403
          ? "authentication_rejected"
          : "transport_mismatch",
    };
  }

  try {
    const parsed = hermesModelsSchema.parse(await readDiscoveryJson(models));
    return {
      kind: "advertised",
      profiles: [...new Set(parsed.data.map((model) => model.id))].sort(
        (left, right) => left.localeCompare(right),
      ),
    };
  } catch {
    return { kind: "rejected", reason: "models_malformed" };
  }
}

export function probeLoopbackPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// Bound the entire response, including ignored additive metadata, before JSON parsing.
async function readDiscoveryJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing discovery body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536)
        throw new Error("Discovery response exceeds byte limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

const parseLoopbackEndpoint = parseHermesEndpoint;

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
