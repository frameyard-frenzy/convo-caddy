import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import type { CaptureProvider } from "../../src/server/capture/capture-provider.js";
import type {
  MartyContext,
  MartyResponse,
} from "../../src/server/marty/marty-provider.js";
import { FakeMartyProvider } from "../../src/server/marty/fake-marty-provider.js";
import { FileSessionRepository } from "../../src/server/persistence/file-session-repository.js";
import { SessionService } from "../../src/server/session-service.js";
import { initializeUserWorkspace } from "../../src/server/workspace/user-workspace.js";

describe("public source-alpha synthetic journey", () => {
  it.each([
    ["/question why is that", false],
    ["/revisit spreadsheets", false],
    ["/question why is that", true],
    ["/revisit spreadsheets", true],
  ] as const)(
    "preserves published output against pending %s (replacement: %s)",
    async (input, replace) => {
      const workspace = mkdtempSync(
        path.join(tmpdir(), "source-alpha-workspace-"),
      );
      const privateState = mkdtempSync(
        path.join(tmpdir(), "source-alpha-state-"),
      );
      initializeUserWorkspace(workspace);
      const prepBytes = `${JSON.stringify(
        {
          schemaVersion: 1,
          title: "Product interview",
          plannedDurationMinutes: 20,
          topics: [{ tier: "must", text: "Tell me about the last attempt." }],
        },
        null,
        2,
      )}\n`;
      writeFileSync(
        path.join(workspace, "prep/current/product.json"),
        prepBytes,
      );
      const provider = new DeferredListProvider();
      let id = 0;
      const service = new SessionService({
        topics: [],
        transcript: [],
        provider,
        captureProvider: new SyntheticCaptureProvider(),
        repository: new FileSessionRepository(privateState),
        userWorkspaceRoot: workspace,
        recallCaptureAvailable: true,
        clock: new FixedClock("2026-09-04T16:00:00.000Z"),
        createId: () =>
          `11111111-2222-4333-8444-${String(++id).padStart(12, "0")}`,
        initialCaptureMode: "live_ready",
      });
      service.selectPrep("product.json");
      expect(
        await service.startRecallCapture({
          meetingUrl: "https://teams.live.com/meet/123456789?p=synthetic",
        }),
      ).toMatchObject({ ok: true });
      expect(
        service.ingestRecallTranscript({
          botId: "synthetic-bot",
          recordingId: "synthetic-recording",
          turn: {
            id: "synthetic-turn-1",
            providerEventId: "synthetic-event-1",
            speakerId: "participant",
            speakerLabel: "Participant",
            text: "The first attempt took two handoffs.",
            startedAtMs: 1_000,
            endedAtMs: 4_000,
            receivedAt: "2026-09-04T16:00:04.000Z",
            final: true,
          },
        }),
      ).toBe("accepted");
      await service.submitInput({
        input: "What should I clarify?",
        mutationId: "ask-1",
      });
      await service.submitInput({
        input: "/question why is that",
        mutationId: "question",
      });
      await service.submitInput({
        input: "/revisit spreadsheets",
        mutationId: "revisit",
      });
      service.setQuestionChecked(
        service.getSnapshot().questions[0]?.id ?? "missing-question",
        true,
      );
      service.setRevisitChecked(
        service.getSnapshot().revisit[0]?.id ?? "missing-revisit",
        true,
      );
      const saved = service.getSnapshot();
      expect(provider.invocationCount).toBe(3);
      provider.defer = true;
      const pending = service.submitInput({
        input,
        mutationId: "pending-list",
      });
      expect(provider.invocationCount).toBe(4);

      for (const [milestone, second] of [
        ["call_ended", "05"],
        ["transcript_done", "06"],
        ["bot_done", "07"],
      ] as const) {
        expect(
          service.ingestRecallLifecycle({
            botId: "synthetic-bot",
            recordingId: "synthetic-recording",
            status: "ended",
            milestone,
            occurredAt: `2026-09-04T16:00:${second}.000Z`,
          }),
        ).toBe("accepted");
      }

      const finishedRoot = path.join(workspace, "finished-conversations");
      const finished = readdirSync(finishedRoot);
      expect(finished).toHaveLength(1);
      const files = readdirSync(
        path.join(finishedRoot, finished[0] ?? ""),
      ).sort();
      expect(files).toEqual([
        "conversation.json",
        "conversation.md",
        "manifest.json",
        "prep.json",
      ]);
      expect(
        readFileSync(
          path.join(finishedRoot, finished[0] ?? "", "prep.json"),
          "utf8",
        ),
      ).toBe(prepBytes);
      expect(service.getSnapshot().lifecycle.finalization.state).toBe(
        "complete",
      );
      const directory = path.join(
        finishedRoot,
        finished[0] ?? "missing-conversation",
      );
      const bytes = () =>
        Object.fromEntries(
          files.map((file) => [
            file,
            readFileSync(path.join(directory, file), "utf8"),
          ]),
        );
      const published = bytes();
      const exported = JSON.parse(published["conversation.json"] ?? "");
      expect(exported.session.questions).toEqual(saved.questions);
      expect(exported.session.revisit).toEqual(saved.revisit);
      if (replace) service.startNextSession();
      const beforeResolution = service.getSnapshot();
      provider.resolve({
        text: "Late output must not be saved.",
        citationTurnIds: ["synthetic-turn-1"],
      });
      expect((await pending).ok).toBe(false);
      expect(service.getSnapshot()).toEqual(beforeResolution);
      expect(bytes()).toEqual(published);
      expect(provider.invocationCount).toBe(4);
      expect(new FileSessionRepository(privateState).load()).toBeNull();
      service.close();
    },
  );
});

class DeferredListProvider extends FakeMartyProvider {
  defer = false;
  #deferredCount = 0;
  override get invocationCount(): number {
    return super.invocationCount + this.#deferredCount;
  }
  #resolve: ((response: MartyResponse) => void) | undefined;

  override requestRevisit(
    context: MartyContext,
    request: { idempotencyKey: string },
    hint?: string,
  ): Promise<MartyResponse> {
    return this.defer
      ? this.pending()
      : super.requestRevisit(context, request, hint);
  }

  override requestQuestion(
    hint: string,
    context: MartyContext,
  ): Promise<MartyResponse> {
    return this.defer ? this.pending() : super.requestQuestion(hint, context);
  }

  pending(): Promise<MartyResponse> {
    this.#deferredCount += 1;
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(response: MartyResponse): void {
    if (!this.#resolve) throw new Error("No pending list request.");
    this.#resolve(response);
  }
}

class SyntheticCaptureProvider implements CaptureProvider {
  readonly region = "us-west-2" as const;

  async createBot(): Promise<{ botId: string }> {
    return { botId: "synthetic-bot" };
  }

  async stopRecordingNotice(): Promise<void> {}
}
