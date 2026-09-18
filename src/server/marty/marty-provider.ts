import type { MartyContext } from "./context-builder.js";
import type { MartyResponse } from "./response-schema.js";

export type { MartyContext } from "./context-builder.js";
export type { MartyResponse } from "./response-schema.js";

export type MartyRequest = {
  idempotencyKey: string;
};

export interface MartyProvider {
  readonly invocationCount: number;
  requestRevisit(
    context: MartyContext,
    request: MartyRequest,
    hint?: string,
  ): Promise<MartyResponse>;
  requestQuestion(
    hint: string,
    context: MartyContext,
    request: MartyRequest,
  ): Promise<MartyResponse>;
  ask(
    question: string,
    context: MartyContext,
    request: MartyRequest,
  ): Promise<MartyResponse>;
}
