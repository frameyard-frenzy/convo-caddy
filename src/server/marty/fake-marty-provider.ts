import type {
  MartyContext,
  MartyProvider,
  MartyRequest,
  MartyResponse,
} from "./marty-provider.js";

function findLastTurn(
  turns: MartyContext["transcript"],
  pattern: RegExp,
): MartyContext["transcript"][number] | undefined {
  return turns.findLast((turn) => pattern.test(turn.text));
}

export class FakeMartyProvider implements MartyProvider {
  #invocationCount = 0;
  #nextFailure: string | null = null;

  get invocationCount(): number {
    return this.#invocationCount;
  }

  failNext(message = "Fake assistant could not answer."): void {
    this.#nextFailure = message;
  }

  async requestRevisit(
    context: MartyContext,
    _request: MartyRequest,
    hint?: string,
  ): Promise<MartyResponse> {
    this.#recordInvocation();
    const citedTurn =
      findLastTurn(context.transcript, /serial|lot mismatch/iu) ??
      context.transcript.at(-1);

    return {
      text: citedTurn
        ? hint?.toLocaleLowerCase().includes("spreadsheet")
          ? "Return to why the spreadsheet replaced the ERP workflow."
          : "Return to the serial-number mismatch and how it changed the exposed lots."
        : "Return to the current thread once the participant has provided more detail.",
      citationTurnIds: citedTurn ? [citedTurn.id] : [],
    };
  }

  async requestQuestion(
    hint: string,
    context: MartyContext,
  ): Promise<MartyResponse> {
    this.#recordInvocation();
    const citedTurn =
      findLastTurn(context.transcript, /spreadsheet|erp|sap/iu) ??
      context.transcript.at(-1);
    return {
      text: /why is that/iu.test(hint)
        ? "Why did you switch from the ERP to a spreadsheet?"
        : `Ask a specific follow-up about: ${hint}`,
      citationTurnIds: citedTurn ? [citedTurn.id] : [],
    };
  }

  async ask(question: string, context: MartyContext): Promise<MartyResponse> {
    this.#recordInvocation();
    const lowerQuestion = question.toLocaleLowerCase();

    if (lowerQuestion.includes("erp") || lowerQuestion.includes("sap")) {
      const citedTurn = findLastTurn(context.transcript, /sap|erp/iu);
      return citedTurn
        ? {
            text: "The participant said formal lot records were in SAP, while the serial-number exception lived in a quality spreadsheet.",
            citationTurnIds: [citedTurn.id],
          }
        : {
            text: "The transcript does not mention an ERP system yet.",
            citationTurnIds: [],
          };
    }

    if (lowerQuestion.includes("who") && /decid|approv/iu.test(question)) {
      const citedTurn = findLastTurn(context.transcript, /containment/iu);
      return {
        text: "The transcript has not established who personally approved the containment change.",
        citationTurnIds: citedTurn ? [citedTurn.id] : [],
      };
    }

    const citedTurn = context.transcript.at(-1);
    return citedTurn
      ? {
          text: `The latest relevant context is: ${citedTurn.text}`,
          citationTurnIds: [citedTurn.id],
        }
      : {
          text: "The transcript does not contain enough context to answer yet.",
          citationTurnIds: [],
        };
  }

  #recordInvocation(): void {
    this.#invocationCount += 1;
    if (this.#nextFailure) {
      const message = this.#nextFailure;
      this.#nextFailure = null;
      throw new Error(message);
    }
  }
}
