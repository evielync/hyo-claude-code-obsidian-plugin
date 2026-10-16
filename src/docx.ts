// Word (.docx) attachments. A .docx is a zip; the body text lives in
// word/document.xml. We pull it out as plain text with light markdown, so
// Claude reads it the same way it reads an attached spreadsheet: headings keep
// their level, list items get a bullet, and tables come through as rows of
// cells separated by " | ". Runs on desktop and mobile (no Node APIs).

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function childrenByName(el: Element, local: string): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(el.children)) {
    if (c.namespaceURI === W_NS && c.localName === local) out.push(c);
  }
  return out;
}

// Text of a paragraph: every w:t in document order, with tabs and line breaks.
function paragraphText(p: Element): string {
  let s = "";
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (c.namespaceURI !== W_NS) {
        walk(c);
        continue;
      }
      switch (c.localName) {
        case "t":
          s += c.textContent || "";
          break;
        case "tab":
          s += "\t";
          break;
        case "br":
        case "cr":
          s += "\n";
          break;
        case "pPr":
        case "rPr":
        case "instrText":
        case "delText":
          break;
        default:
          walk(c);
      }
    }
  };
  walk(p);
  return s;
}

function paragraphPrefix(p: Element): string {
  const pPr = childrenByName(p, "pPr")[0];
  if (!pPr) return "";
  const style = childrenByName(pPr, "pStyle")[0]?.getAttributeNS(W_NS, "val") || "";
  const heading = style.match(/^(?:Heading|heading)\s?(\d)$/);
  if (heading) return "#".repeat(Math.min(Number(heading[1]), 6)) + " ";
  if (/^Title$/i.test(style)) return "# ";
  if (childrenByName(pPr, "numPr").length) return "- ";
  return "";
}

function blockText(container: Element, lines: string[]): void {
  for (const c of Array.from(container.children)) {
    if (c.namespaceURI !== W_NS) continue;
    if (c.localName === "p") {
      const text = paragraphText(c);
      lines.push(text.trim() ? paragraphPrefix(c) + text : "");
    } else if (c.localName === "tbl") {
      for (const tr of childrenByName(c, "tr")) {
        const cells = childrenByName(tr, "tc").map((tc) => {
          const inner: string[] = [];
          blockText(tc, inner);
          return inner.filter((l) => l.trim()).join(" ").trim();
        });
        lines.push(cells.join(" | "));
      }
      lines.push("");
    } else if (c.localName === "sdt") {
      // Content controls (e.g. a table of contents) wrap their own blocks.
      const content = childrenByName(c, "sdtContent")[0];
      if (content) blockText(content, lines);
    }
  }
}

export async function docxToText(buf: ArrayBuffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Not a Word document (word/document.xml missing)");
  const xml = await entry.async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("Could not parse word/document.xml");
  }
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) return "";
  const lines: string[] = [];
  blockText(body, lines);
  // Collapse runs of blank lines left by empty paragraphs.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
