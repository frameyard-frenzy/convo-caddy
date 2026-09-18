import { prepMarkdownBlocks, prepListRows } from "./prep-markdown.js";
import { z } from "zod";
import { sessionStateSchema } from "../../domain/session-state-schema.js";
import type { SessionState } from "../../domain/types.js";

// Only preparation content, never transcript/chat/provider/session state.
export const prepContentSchema = z
  .strictObject({
    topics: sessionStateSchema.shape.topics,
    humanContext: sessionStateSchema.shape.humanContext.unwrap(),
    notes: sessionStateSchema.shape.notes,
    questions: sessionStateSchema.shape.questions,
    revisit: sessionStateSchema.shape.revisit,
    displayName: z.string().max(80).nullable(),
  })
  .superRefine((content, context) => {
    const items = [
      ...content.topics,
      ...content.humanContext.personSummary,
      ...content.notes,
      ...content.questions,
      ...content.revisit,
    ];
    if (new Set(items.map((item) => item.id)).size !== items.length)
      context.addIssue({
        code: "custom",
        message: "Preparation item identities must be unique.",
      });
    for (const item of [
      ...content.notes,
      ...content.questions,
      ...content.revisit,
    ])
      if (
        item.transcriptRef.anchorTurnId !== null ||
        item.transcriptRef.windowTurnIds.length
      )
        context.addIssue({
          code: "custom",
          message:
            "Preparation cannot refer to another conversation's transcript.",
        });
  });
export type PrepContent = z.infer<typeof prepContentSchema>;
export function preparationContent(state: SessionState): PrepContent {
  return prepContentSchema.parse({
    topics: state.topics,
    humanContext: state.humanContext,
    notes: state.notes,
    questions: state.questions,
    revisit: state.revisit,
    displayName: state.lifecycle.displayName,
  });
}
export const contentComment =
  /<!-- convo-caddy-preparation:([A-Za-z0-9+/=]+) -->/g;
export function readContentComment(bytes: string): PrepContent | undefined {
  const matches = [...bytes.matchAll(contentComment)];
  if (matches.length > 1)
    throw new Error("Use one Convo Caddy preparation record.");
  if (!matches[0]) return undefined;
  return decodePreparation(
    JSON.parse(Buffer.from(matches[0][1]!, "base64").toString("utf8")),
  );
}

// Visible Markdown is the text/check authority; the bounded comment retains
// identities and timestamps that Markdown lists cannot express.
export function reconcileMarkdownContent(
  bytes: string,
  base: {
    title: string;
    plannedDurationMinutes: number;
    personSummary?: string[];
    topics: Array<{ tier: "must" | "more"; text: string }>;
  },
  saved: PrepContent,
): PrepContent {
  const lists = new Map<string, Array<{ text: string; checked: boolean }>>();
  const blocks = prepMarkdownBlocks(bytes.replace(contentComment, ""));
  for (const section of blocks.sections.filter((x) =>
    [
      "must",
      "more avenues",
      "person summary",
      "notes",
      "questions",
      "revisit",
    ].includes(x.heading),
  )) {
    if (lists.has(section.heading))
      throw new Error(`Use ${section.heading} once in preparation.`);
    lists.set(
      section.heading,
      prepListRows(section.body, section.heading === "person summary"),
    );
  }
  const used = new Set<string>();
  function id(
    previous: { id: string } | undefined,
    prefix: string,
    index: number,
  ): string {
    const candidate = previous?.id ?? `${prefix}-${index + 1}`;
    if (used.has(candidate))
      throw new Error("Preparation item identities must be unique.");
    used.add(candidate);
    return candidate;
  }
  const topics = base.topics.map((topic, index) => {
    const previous = saved.topics[index];
    const tierIndex = base.topics
      .slice(0, index)
      .filter((x) => x.tier === topic.tier).length;
    return {
      ...previous,
      ...topic,
      id: id(previous, "prep", index),
      checked:
        lists.get(topic.tier === "must" ? "must" : "more avenues")?.[tierIndex]
          ?.checked ?? false,
    };
  });
  const humanContext = {
    title: base.title,
    plannedDurationMinutes: base.plannedDurationMinutes,
    personSummary: (base.personSummary ?? []).map((text, index) => ({
      id: id(saved.humanContext.personSummary[index], "summary", index),
      text,
    })),
  };
  const reference = {
    createdAt: "1970-01-01T00:00:00.000Z",
    relativeMs: 0,
    transcriptRef: {
      anchorTurnId: null,
      windowTurnIds: [],
      capturedAt: "1970-01-01T00:00:00.000Z",
      relativeMs: 0,
    },
  };
  const result = { ...saved, topics, humanContext };
  for (const key of ["notes", "questions", "revisit"] as const) {
    const items = (lists.get(key) ?? []).map((item, index) => {
      const previous = saved[key][index];
      return {
        ...reference,
        ...previous,
        id: id(previous, key, index),
        text: item.text,
        ...(key === "notes" ? {} : { checked: item.checked }),
      };
    });
    // Schema validation below handles the distinct note/checklist shapes.
    Object.assign(result, { [key]: items });
  }
  return prepContentSchema.parse(result);
}

// On disk, text and title occur only once. This also keeps large, valid legacy
// JSON titles within the existing byte cap when a small observation is added.
const metadataSchema = z.strictObject({
  topics: z.array(
    sessionStateSchema.shape.topics.element.omit({ text: true, tier: true }),
  ),
  summaryIds: z.array(z.string().min(1)),
  notes: z.array(
    sessionStateSchema.shape.notes.element
      .omit({ text: true })
      .extend({ text: z.string().optional() }),
  ),
  questions: z.array(
    sessionStateSchema.shape.questions.element
      .omit({ text: true })
      .extend({ text: z.string().optional() }),
  ),
  revisit: z.array(
    sessionStateSchema.shape.revisit.element
      .omit({ text: true })
      .extend({ text: z.string().optional() }),
  ),
  displayName: z.string().max(80).nullable(),
});
export function encodePreparation(
  content: PrepContent,
  markdown: boolean,
): unknown {
  const marks = (key: "notes" | "questions" | "revisit") =>
    content[key].map(({ text, ...item }) => ({
      ...item,
      ...(markdown ? {} : { text }),
    }));
  return {
    topics: content.topics.map(({ text: _text, tier: _tier, ...item }) => item),
    summaryIds: content.humanContext.personSummary.map((x) => x.id),
    notes: marks("notes"),
    questions: marks("questions"),
    revisit: marks("revisit"),
    displayName: content.displayName,
  };
}
export function decodePreparation(
  value: unknown,
  base?: {
    title: string;
    plannedDurationMinutes: number;
    personSummary?: string[];
    topics: Array<{ text: string; tier: "must" | "more" }>;
  },
): PrepContent {
  const meta = metadataSchema.parse(value);
  const marks = (key: "notes" | "questions" | "revisit") =>
    meta[key].map((item) => {
      if (base && !item.text)
        throw new Error("JSON preparation marks must contain text.");
      return { ...item, text: item.text ?? "Pending visible text" };
    });
  return prepContentSchema.parse({
    topics: (base?.topics ?? meta.topics).map((_item, i) => ({
      ...(meta.topics[i] ?? { id: `prep-${i + 1}`, checked: false }),
      tier: base?.topics[i]?.tier ?? "must",
      text: base?.topics[i]?.text ?? "Pending visible text",
    })),
    humanContext: {
      title: base?.title ?? "Pending visible title",
      plannedDurationMinutes: base?.plannedDurationMinutes ?? 30,
      personSummary: (base?.personSummary ?? meta.summaryIds).map(
        (_item, i) => ({
          id: meta.summaryIds[i] ?? `summary-${i + 1}`,
          text: base?.personSummary?.[i] ?? "Pending visible text",
        }),
      ),
    },
    notes: marks("notes"),
    questions: marks("questions"),
    revisit: marks("revisit"),
    displayName: meta.displayName,
  });
}
