import type {
  MartyContext,
  MartyProvider,
  MartyResponse,
} from "./marty-provider.js";

const UNAVAILABLE_MESSAGE =
  "Assistant is unavailable until the server-side Hermes connection is configured.";

export class UnavailableMartyProvider implements MartyProvider {
  #invocationCount = 0;

  get invocationCount(): number {
    return this.#invocationCount;
  }

  async requestRevisit(_context: MartyContext): Promise<MartyResponse> {
    return this.#fail();
  }

  async requestQuestion(
    _hint: string,
    _context: MartyContext,
  ): Promise<MartyResponse> {
    return this.#fail();
  }

  async ask(_question: string, _context: MartyContext): Promise<MartyResponse> {
    return this.#fail();
  }

  #fail(): never {
    this.#invocationCount += 1;
    throw new Error(UNAVAILABLE_MESSAGE);
  }
}
