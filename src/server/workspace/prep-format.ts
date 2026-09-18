import {
  prepMarkdownBlocks,
  isPrepContinuation,
  prepListBullet,
} from "./prep-markdown.js";
import path from "node:path";
import { z } from "zod";
import {
  prepContentSchema,
  readContentComment,
  contentComment,
  reconcileMarkdownContent,
  encodePreparation,
  decodePreparation,
} from "./prep-content.js";

export const MAX_PREP_BYTES = 256 * 1024;
const prepBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1),
  plannedDurationMinutes: z.number().int().positive(),
  personSummary: z
    .array(z.string().trim().min(1).max(4000))
    .max(200)
    .optional(),
  savedContent: prepContentSchema.optional(),
  topics: z.array(
    z.strictObject({
      tier: z.enum(["must", "more"]),
      text: z.string().trim().min(1),
    }),
  ),
});
export const prepSchema = prepBaseSchema.refine(
  (prep) => prep.topics.length > 0 || prep.savedContent !== undefined,
  "Add at least one prepared question, or save an explicitly edited preparation.",
);
export type InterviewPrep = z.infer<typeof prepSchema>;
export function prepExtension(name: string): ".md" | ".json" {
  const extension = path.extname(name).toLowerCase();
  if (extension !== ".md" && extension !== ".json")
    throw new Error(
      "Choose a Markdown (.md) prep file; legacy .json preps are also readable.",
    );
  return extension;
}
export function parsePrep(bytes: string, name: string): InterviewPrep {
  if (Buffer.byteLength(bytes, "utf8") > MAX_PREP_BYTES || bytes.includes("\0"))
    throw new Error(
      "Prep must be text smaller than 256 KiB, without null characters.",
    );
  if (prepExtension(name) === ".json") {
    const { preparation, ...raw } = JSON.parse(bytes);
    const parsed =
      preparation === undefined
        ? prepSchema.parse(raw)
        : prepBaseSchema.parse(raw);
    return preparation === undefined
      ? parsed
      : prepSchema.parse({
          ...parsed,
          savedContent: decodePreparation(preparation, parsed),
        });
  }
  const savedContent = readContentComment(bytes);
  // Keep foreign sections intact in source; parse only the owned content.
  const blocks = prepMarkdownBlocks(bytes.replace(contentComment, ""));
  const body =
    blocks.preamble +
    blocks.sections
      .filter((section) =>
        ["person summary", "must", "more avenues"].includes(section.heading),
      )
      .map((section) => section.header + section.body)
      .join("");
  let title = "";
  let duration = 30;
  let hasDuration = false;
  let tier: "must" | "more" | "summary" | undefined;
  const personSummary: string[] = [];
  const sections = new Set<string>();
  const topics: InterviewPrep["topics"] = [];
  const fail = (line: number, message: string): never => {
    throw new Error(`Line ${line}: ${message}`);
  };
  for (const [index, raw] of body
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .entries()) {
    const line = raw.trim();
    if (!line) continue;
    const previous = topics.at(-1);
    if (/^##\s+person\s+summary(?:\s+#+)?$/i.test(line)) {
      if (sections.has("summary")) fail(index + 1, "Use Person summary once.");
      sections.add("summary");
      tier = "summary";
      continue;
    }
    if (tier === "summary" && !/^##\s/.test(line)) {
      const bullet = /^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
      if (bullet) personSummary.push(bullet[1]!.trim());
      else if (personSummary.length && !/^(#|```|~~~)/.test(line))
        personSummary[personSummary.length - 1] += `\n${line}`;
      else fail(index + 1, "Use bullets under Person summary.");
      continue;
    }
    if (isPrepContinuation(raw) && tier && previous?.tier === tier) {
      previous.text += `\n${line}`;
      continue;
    }
    const list = prepListBullet(raw);
    if (list) {
      if (!tier)
        fail(index + 1, "Put questions under ## Must or ## More Avenues.");
      const text = list.text;
      if (!text) fail(index + 1, "Add text to the question bullet.");
      topics.push({ tier: tier as "must" | "more", text });
      continue;
    }
    const heading = /^#\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      if (title || sections.size)
        fail(
          index + 1,
          "Use one # Interview title before the question sections.",
        );
      title = heading[1]?.trim() ?? "";
      continue;
    }
    if (/^duration\s*:/i.test(line)) {
      const match = /^duration\s*:\s*(\d+)\s*(?:minutes?|mins?)?$/i.exec(line);
      if (hasDuration || sections.size || !match)
        fail(
          index + 1,
          "Use one Duration: 30 minutes line before the sections.",
        );
      duration = Number(match?.[1]);
      hasDuration = true;
      if (duration < 1 || (!savedContent && duration > 480))
        fail(index + 1, "Duration must be 1–480 minutes.");
      continue;
    }
    const section = /^##\s+(must|more\s+avenues)(?:\s+#+)?$/i.exec(line);
    if (section) {
      tier = section[1]?.toLowerCase() === "must" ? "must" : "more";
      if (sections.has(tier))
        fail(index + 1, "Use each question section once.");
      sections.add(tier);
      continue;
    }
    if (tier && previous?.tier === tier && !/^(#|```|~~~)/.test(line)) {
      previous.text += `\n${line}`;
      continue;
    }
    fail(
      index + 1,
      "Use # Interview title, optional Duration: 30 minutes, and bullet questions under ## Must / ## More Avenues.",
    );
  }
  if (!title || (!savedContent && title.length > 200))
    throw new Error("Add one # Interview title (1–200 characters).");
  if (
    (!savedContent && !topics.length) ||
    topics.length > 200 ||
    topics.some((t) => t.text.length > 4000)
  )
    throw new Error(
      "Add 1–200 question bullets, each at most 4000 characters.",
    );
  if (
    !savedContent &&
    (/^\s*(?:[-+*]|\d+[.)])\s+\[[xX]\]/m.test(body) ||
      blocks.sections.some((x) =>
        ["notes", "questions", "revisit"].includes(x.heading),
      ))
  ) {
    const base = {
      title,
      plannedDurationMinutes: duration,
      personSummary,
      topics,
    };
    const initial = {
      topics: topics.map((t, i) => ({
        ...t,
        id: `prep-${i + 1}`,
        checked: false,
      })),
      humanContext: {
        title,
        plannedDurationMinutes: duration,
        personSummary: personSummary.map((text, i) => ({
          id: `summary-${i + 1}`,
          text,
        })),
      },
      notes: [],
      questions: [],
      revisit: [],
      displayName: null,
    };
    return prepSchema.parse({
      schemaVersion: 1,
      title,
      plannedDurationMinutes: duration,
      ...(sections.has("summary") ? { personSummary } : {}),
      topics,
      savedContent: reconcileMarkdownContent(bytes, base, initial),
    });
  }

  return prepSchema.parse({
    schemaVersion: 1,
    title,
    plannedDurationMinutes: duration,
    ...(sections.has("summary") ? { personSummary } : {}),
    topics,
    ...(savedContent
      ? {
          savedContent: reconcileMarkdownContent(
            bytes,
            { title, plannedDurationMinutes: duration, personSummary, topics },
            savedContent,
          ),
        }
      : {}),
  });
}
export function renderPrepMarkdown(prep: InterviewPrep): string {
  const lines = [
    `# ${prep.title}`,
    "",
    `Duration: ${prep.plannedDurationMinutes} minutes`,
    "",
  ];
  if (prep.personSummary)
    lines.push(
      "## Person summary",
      "",
      ...prep.personSummary.map((text) => `- ${text.replaceAll("\n", "\n  ")}`),
      "",
    );
  for (const [tier, heading] of [
    ["must", "Must"],
    ["more", "More Avenues"],
  ] as const) {
    lines.push(
      `## ${heading}`,
      "",
      ...prep.topics
        .filter((t) => t.tier === tier)
        .map((t) => `- [ ] ${t.text.replaceAll("\n", "\n  ")}`),
      "",
    );
  }
  if (prep.savedContent) {
    for (const key of ["notes", "questions", "revisit"] as const) {
      lines.push(
        `## ${key[0]!.toUpperCase() + key.slice(1)}`,
        "",
        ...prep.savedContent[key].map(
          (x) =>
            `- ${"checked" in x ? `[${x.checked ? "x" : " "}] ` : ""}${x.text.replaceAll("\n", "\n  ")}`,
        ),
        "",
      );
    }
    lines.push(
      `<!-- convo-caddy-preparation:${Buffer.from(JSON.stringify(encodePreparation(prep.savedContent, true))).toString("base64")} -->`,
    );
  }
  const result = `${lines.join("\n")}\n`;
  const reparsed = parsePrep(result, "prep.md");
  const ordered = {
    ...prep,
    topics: [
      ...prep.topics.filter((topic) => topic.tier === "must"),
      ...prep.topics.filter((topic) => topic.tier === "more"),
    ],
  };
  const { savedContent: _reparsedContent, ...reparsedBasic } = reparsed;
  const { savedContent: _orderedContent, ...orderedBasic } =
    prepSchema.parse(ordered);
  if (JSON.stringify(reparsedBasic) !== JSON.stringify(orderedBasic))
    throw new Error(
      "This edit would change its Markdown meaning. Edit the Markdown file directly, then choose it again.",
    );
  return result;
}
