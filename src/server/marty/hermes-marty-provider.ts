import { z } from "zod";
import { parseHermesEndpoint } from "../connectivity/hermes-endpoint.js";
import { HermesDispatchAuthority } from "./hermes-dispatch-authority.js";
import type {
  MartyContext,
  MartyProvider,
  MartyRequest,
  MartyResponse,
} from "./marty-provider.js";
import { buildMartyPrompt } from "./prompts.js";
import { parseMartyResponse } from "./response-schema.js";

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.strictObject({
          content: z.string(),
          role: z.string().optional(),
          tool_calls: z.array(z.unknown()).max(0).optional(),
          function_call: z.null().optional(),
        }),
        finish_reason: z.string(),
      }),
    )
    .length(1),
});

export type HermesMartyProviderOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxInputBytes: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  dispatchAuthority?: HermesDispatchAuthority;
};

export class HermesMartyProvider implements MartyProvider {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #maxInputBytes: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #dispatchAuthority: HermesDispatchAuthority;
  #invocationCount = 0;

  constructor(options: HermesMartyProviderOptions) {
    this.#endpoint = `${normalizeHermesBaseUrl(options.baseUrl)}/v1/chat/completions`;
    this.#apiKey = requireNonempty(options.apiKey, "Hermes API key");
    this.#model = requireNonempty(options.model, "Hermes model name");
    this.#maxInputBytes = requirePositiveInteger(
      options.maxInputBytes,
      "Hermes maximum input bytes",
    );
    this.#timeoutMs = requirePositiveInteger(
      options.timeoutMs,
      "Hermes timeout",
    );
    this.#fetch = options.fetchImpl ?? fetch;
    this.#dispatchAuthority =
      options.dispatchAuthority ??
      HermesDispatchAuthority.readyForUnmanagedConnection();
  }

  get invocationCount(): number {
    return this.#invocationCount;
  }

  requestRevisit(
    context: MartyContext,
    request: MartyRequest,
    hint?: string,
  ): Promise<MartyResponse> {
    return this.#request(
      hint === undefined ? { kind: "revisit" } : { kind: "revisit", hint },
      context,
      request,
    );
  }

  requestQuestion(
    hint: string,
    context: MartyContext,
    request: MartyRequest,
  ): Promise<MartyResponse> {
    return this.#request({ kind: "question", hint }, context, request);
  }

  ask(
    question: string,
    context: MartyContext,
    request: MartyRequest,
  ): Promise<MartyResponse> {
    return this.#request({ kind: "answer", question }, context, request);
  }

  async #request(
    task: Parameters<typeof buildMartyPrompt>[0],
    context: MartyContext,
    request: MartyRequest,
  ): Promise<MartyResponse> {
    const idempotencyKey = requireSafeHeaderValue(
      request.idempotencyKey,
      "Hermes idempotency key",
    );
    const prompt = buildMartyPrompt(
      task,
      context,
      {
        maxInputBytes: this.#maxInputBytes,
      },
      idempotencyKey,
    );
    const body = JSON.stringify({
      model: this.#model,
      stream: false,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.input },
      ],
    });
    return this.#dispatchAuthority.run(async () => {
      this.#invocationCount += 1;

      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        if (
          error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        ) {
          throw new Error(
            `Hermes did not respond within ${this.#timeoutMs} ms.`,
          );
        }
        throw new Error("Convo Caddy could not reach Hermes.");
      }

      if (!response.ok) {
        throw new Error(`Hermes returned HTTP ${response.status}.`);
      }
      assertOpaqueHermesSession(response);

      let completion: z.infer<typeof completionSchema>;
      try {
        completion = completionSchema.parse(await response.json());
      } catch {
        throw new Error("Hermes returned a malformed API response.");
      }

      const choice = completion.choices[0];
      if (choice?.finish_reason !== "stop") {
        throw new Error("Hermes did not complete the assistant response.");
      }

      let structured: unknown;
      try {
        structured = JSON.parse(choice.message.content);
      } catch {
        throw new Error("Assistant returned malformed structured output.");
      }

      try {
        return parseMartyResponse(
          structured,
          context.transcript.map((turn) => turn.id),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Assistant returned an invalid transcript citation."
        ) {
          throw error;
        }
        throw new Error("Assistant returned malformed structured output.");
      }
    });
  }
}

export function normalizeHermesBaseUrl(value: string): string {
  const endpoint = parseHermesEndpoint(value);
  return endpoint.pathname === "/"
    ? endpoint.origin
    : `${endpoint.origin}${endpoint.pathname}`;
}

function assertOpaqueHermesSession(response: Response): void {
  const actualSessionId = response.headers.get("x-hermes-session-id");
  if (!actualSessionId) {
    throw new Error("Hermes did not return its session boundary.");
  }
  if (
    actualSessionId.length > 256 ||
    Array.from(actualSessionId).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new Error("Hermes returned malformed session metadata.");
  }
}

function requireSafeHeaderValue(value: string, label: string): string {
  if (!value || value.length > 256 || /[^\u0021-\u007e]/u.test(value)) {
    throw new Error(`${label} must contain 1–256 visible ASCII characters.`);
  }
  return value;
}

function requireNonempty(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
