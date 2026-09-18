// Source ranges let the writer replace only owned list blocks. Headings in YAML
// or fenced examples are author material, not editable preparation sections.
export function prepMarkdownBlocks(bytes: string) {
  const frontmatter =
    /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(bytes)?.[0] ?? "";
  const sections: Array<{
    heading: string;
    header: string;
    body: string;
    start: number;
    end: number;
  }> = [];
  let offset = frontmatter.length;
  let fence: string | undefined;
  for (const line of bytes.slice(offset).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
    } else if (!fence) {
      const heading = /^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?\n?$/.exec(
        line,
      )?.[1];
      if (heading)
        sections.push({
          heading: heading.toLowerCase().replace(/\s+/g, " "),
          header: line,
          body: "",
          start: offset,
          end: bytes.length,
        });
    }
    offset += line.length;
  }
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    section.end = sections[i + 1]?.start ?? bytes.length;
    section.body = bytes.slice(
      section.start + section.header.length,
      section.end,
    );
  }
  return {
    frontmatter,
    preamble: bytes.slice(
      frontmatter.length,
      sections[0]?.start ?? bytes.length,
    ),
    sections,
  };
}

// Prepared-list indentation takes precedence over bullet syntax: a nested
// bullet belongs to the previous question, not a new positional identity.
export function isPrepContinuation(raw: string): boolean {
  return /^\s{2,}\S/.test(raw);
}
export function prepListBullet(raw: string) {
  const match = /^\s*(?:[-+*]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/.exec(raw);
  return match
    ? { text: match[2]!.trim(), checked: /x/i.test(match[1] ?? "") }
    : undefined;
}

// Keep original bytes beside parsed text so unchanged rows can be reused without
// losing ordinary (unindented) continuations. Summary retains bullet-first rules.
export function prepListRows(body: string, summary = false) {
  const rows: Array<{ text: string; checked: boolean; source: string }> = [];
  for (const raw of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const previous = rows.at(-1);
    const bullet = prepListBullet(raw.trimEnd());
    if (bullet && !(previous && !summary && isPrepContinuation(raw))) {
      rows.push({ ...bullet, source: raw });
    } else if (previous) {
      previous.source += raw;
      if (raw.trim()) previous.text += `\n${raw.trim()}`;
    }
  }
  return rows.map((row) => ({
    ...row,
    source: row.source.replace(/\r?\n$/, ""),
  }));
}
