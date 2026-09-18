import { prepMarkdownBlocks, prepListRows } from "./prep-markdown.js";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionState } from "../../domain/types.js";
import {
  contentComment,
  preparationContent,
  encodePreparation,
} from "./prep-content.js";
import { MAX_PREP_BYTES, parsePrep } from "./prep-format.js";
import { readPrepText } from "./user-workspace.js";

export function renderUpdatedPrep(
  bytes: string,
  name: string,
  state: SessionState,
): string {
  const before = parsePrep(bytes, name);
  const content = preparationContent(state);
  if (isDeepStrictEqual(before.savedContent, content)) return bytes;
  const prep = {
    schemaVersion: 1 as const,
    title: content.humanContext.title,
    plannedDurationMinutes: content.humanContext.plannedDurationMinutes,
    personSummary: content.humanContext.personSummary.map((x) => x.text),
    topics: content.topics.map(({ tier, text }) => ({ tier, text })),
    savedContent: content,
  };
  if (path.extname(name).toLowerCase() === ".json") {
    const { savedContent: _content, ...basic } = prep;
    return bounded(
      `${JSON.stringify({ ...basic, preparation: encodePreparation(content, false) }, null, 2)}\n`,
      name,
    );
  }
  const newline = bytes.includes("\r\n") ? "\r\n" : "\n";
  let result = bytes.replace(contentComment, "");
  const blocks = prepMarkdownBlocks(result);
  let preamble = blocks.preamble;
  if (before.title !== prep.title)
    preamble = preamble.replace(/^#\s+[^\r\n]+/m, () => `# ${prep.title}`);
  if (before.plannedDurationMinutes !== prep.plannedDurationMinutes) {
    const line = `Duration: ${prep.plannedDurationMinutes} minutes`;
    preamble = /^duration\s*:/im.test(preamble)
      ? preamble.replace(/^duration\s*:[^\r\n]*/im, line)
      : preamble.replace(/^(#\s+[^\r\n]+)/m, `$1${newline}${newline}${line}`);
  }
  result =
    blocks.frontmatter +
    preamble +
    result.slice(blocks.frontmatter.length + blocks.preamble.length);
  function section(
    heading: string,
    texts: Array<{ text: string; checked?: boolean }>,
    prior: Array<{ text: string; checked?: boolean }>,
  ) {
    if (isDeepStrictEqual(texts, prior)) return;
    const found = prepMarkdownBlocks(result).sections.find(
      (x) => x.heading === heading.toLowerCase(),
    );
    const oldRows = prepListRows(
      found?.body ?? "",
      heading === "Person summary",
    ).map((row) => row.source);
    const body = texts
      .map((x, index) => {
        const unchanged = prior.findIndex((p) => isDeepStrictEqual(p, x));
        if (unchanged >= 0 && oldRows[unchanged]) return oldRows[unchanged];
        const marker =
          /^([ \t]*(?:[-+*]|\d+[.)])\s+)/.exec(oldRows[index] ?? "")?.[1] ??
          "- ";
        return `${marker}${x.checked === undefined ? "" : `[${x.checked ? "x" : " "}] `}${x.text.replaceAll("\n", `${newline}  `)}`;
      })
      .join(newline);
    // Preserve the author heading and its surrounding spacing when replacing an owned list.
    if (found) {
      result =
        result.slice(0, found.start) +
        `${found.header}${newline}${body}${newline}${newline}` +
        result.slice(found.end);
    } else if (texts.length)
      result += `${newline}## ${heading}${newline}${newline}${body}${newline}`;
  }
  const old = before.savedContent;
  for (const tier of ["must", "more"] as const)
    section(
      tier === "must" ? "Must" : "More Avenues",
      content.topics
        .filter((x) => x.tier === tier)
        .map(({ text, checked }) => ({ text, checked })),
      (old?.topics ?? before.topics.map((t) => ({ ...t, checked: false })))
        .filter((x) => x.tier === tier)
        .map(({ text, checked }) => ({ text, checked })),
    );
  section(
    "Person summary",
    content.humanContext.personSummary.map(({ text }) => ({ text })),
    (before.personSummary ?? []).map((text) => ({ text })),
  );
  section(
    "Notes",
    content.notes.map(({ text }) => ({ text })),
    (old?.notes ?? []).map(({ text }) => ({ text })),
  );
  for (const key of ["questions", "revisit"] as const)
    section(
      key === "questions" ? "Questions" : "Revisit",
      content[key].map(({ text, checked }) => ({ text, checked })),
      (old?.[key] ?? []).map(({ text, checked }) => ({ text, checked })),
    );
  result += `${newline}<!-- convo-caddy-preparation:${Buffer.from(JSON.stringify(encodePreparation(content, true))).toString("base64")} -->${newline}`;
  bounded(result, name);
  if (!isDeepStrictEqual(parsePrep(result, name).savedContent, content))
    throw new Error(
      "This text cannot roundtrip as prep Markdown. Your draft was kept; revise its Markdown structure and retry Save.",
    );
  return result;
}
function bounded(bytes: string, name: string): string {
  if (Buffer.byteLength(bytes) > MAX_PREP_BYTES)
    throw new Error("Prep would exceed 256 KiB. Your draft was kept.");
  parsePrep(bytes, name);
  return bytes;
}

// Never chmod an author's directory or follow a substituted parent/leaf link.
export function replaceSelectedPrep(
  file: string,
  expected: string,
  next: string,
  beforeRename?: () => void,
): void {
  if (file.split(path.sep).some((part) => part.endsWith(".app")))
    throw new Error(
      "Choose a writable prep outside the application bundle. Your draft was kept.",
    );
  const parent = path.dirname(file);
  if (realpathSync(parent) !== parent)
    throw new Error(
      "Prep location changed. Choose it again; your draft was kept.",
    );
  const original = lstatSync(file);
  if (!original.isFile() || !(original.mode & 0o222))
    throw new Error("The selected prep is not writable. Your draft was kept.");
  if (readPrepText(file) !== expected)
    throw new Error(
      "The selected prep changed outside Convo Caddy. Your draft was kept; restore the file or choose it again.",
    );
  if (expected === next) return;
  const temp = path.join(parent, `.caddy-prep-${randomUUID()}.tmp`);
  let renamed = false;
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, next, "utf8");
      fchmodSync(fd, original.mode & 0o777);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    beforeRename?.();
    const current = lstatSync(file);
    if (
      realpathSync(parent) !== parent ||
      !current.isFile() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      readPrepText(file) !== expected
    )
      throw new Error(
        "The selected prep changed while saving. Your draft was kept.",
      );
    renameSync(temp, file);
    renamed = true;
    const directory = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (!renamed) unlinkSync(temp);
  }
}
