// Escaped bundled instructions. Only the two known topology fragments become
// links; in-page jumps preserve the current setup document and its draft.
export function renderSetupGuide(markdown: string): string {
  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const topologyIds = new Map([
    ["This Mac", "this-mac"],
    ["Another Mac", "another-mac"],
  ]);
  const inline = (value: string) =>
    escapeHtml(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(
        /\[(This Mac|Another Mac)\]\(#(this-mac|another-mac)\)/g,
        (literal, title: string, id: string) =>
          topologyIds.get(title) === id
            ? `<a href="#${id}">${title}</a>`
            : literal,
      );
  const renderCode = (lines: string[], copyable: boolean) => {
    const escaped = escapeHtml(lines.join("\n"));
    return copyable || lines.length >= 10
      ? `<p>Click inside the command box, press Command-A, then Command-C to copy the complete command. It is read-only.</p><textarea class="setup-command" readonly wrap="off" aria-label="Copy complete command" spellcheck="false">${escaped}</textarea>`
      : `<pre>${escaped}</pre>`;
  };
  const output: string[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let copyable = false;
  let section = false;
  let listTag: "ol" | "ul" = "ul";
  let listItems: string[] = [];
  const flushList = () => {
    if (listItems.length) {
      output.push(
        `<${listTag}>${listItems.map((item) => `<li>${inline(item)}</li>`).join("")}</${listTag}>`,
      );
      listItems = [];
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${inline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  for (const line of markdown.split("\n")) {
    if (code !== null) {
      if (line === "```") {
        output.push(renderCode(code, copyable));
        code = null;
      } else code.push(line);
      continue;
    }
    const item = line.match(/^(\d+\. |[-] )(.*)$/);
    if (item) {
      flushParagraph();
      const tag = item[1] === "- " ? "ul" : "ol";
      if (listTag !== tag) {
        flushList();
        listTag = tag;
      }
      listItems.push(item[2] ?? "");
      continue;
    }
    flushList();
    if (/^```\w*$/.test(line)) {
      flushParagraph();
      code = [];
      copyable = line === "```command";
    } else if (/^#+ /.test(line)) {
      flushParagraph();
      const title = line.replace(/^#+ /, "");
      if (line.startsWith("## ") && section) {
        output.push("</section>");
        section = false;
      }
      const id = line.startsWith("## ") ? topologyIds.get(title) : undefined;
      if (id) {
        output.push(
          `<section aria-labelledby="${id}"><h3 id="${id}" tabindex="-1">${inline(title)}</h3>`,
        );
        section = true;
      } else
        output.push(
          `<h${line.startsWith("### ") ? 4 : 3}>${inline(title)}</h${line.startsWith("### ") ? 4 : 3}>`,
        );
    } else if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }
  if (code !== null) output.push(renderCode(code, copyable));
  flushParagraph();
  flushList();
  if (section) output.push("</section>");
  return output.join("\n");
}
