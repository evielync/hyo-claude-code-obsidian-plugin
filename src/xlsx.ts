// Excel (.xlsx / .xlsm) attachments. An .xlsx is a zip of XML parts; this
// reads the cell values out as CSV-style text, one block per sheet:
//
//   # Sheet: Budget
//   Item,Cost
//   Rent,1200
//
// Formula cells give their last calculated value (what Excel shows), and
// date-formatted cells come through as ISO dates. Runs on desktop and mobile
// (fflate is pure JavaScript, DOMParser is built into Obsidian).

import { unzipSync, strFromU8 } from "fflate";

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

type Parts = Record<string, Uint8Array>;

function elementChildren(el: Element, ns: string, local: string): Element[] {
  const out: Element[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (child.namespaceURI === ns && child.localName === local) out.push(child);
  }
  return out;
}

function firstChild(el: Element, ns: string, local: string): Element | undefined {
  return elementChildren(el, ns, local)[0];
}

function parseXml(parts: Parts, path: string): Document | null {
  const bytes = parts[path];
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error(`Could not parse ${path}`);
  }
  return doc;
}

/** Text of an <si> or <is> element: plain <t>, or the <t> of every rich-text run. */
function stringItemText(el: Element): string {
  const plain = firstChild(el, MAIN_NS, "t");
  if (plain) return plain.textContent ?? "";
  return elementChildren(el, MAIN_NS, "r")
    .map((r) => firstChild(r, MAIN_NS, "t")?.textContent ?? "")
    .join("");
}

function readSharedStrings(parts: Parts): string[] {
  const doc = parseXml(parts, "xl/sharedStrings.xml");
  if (!doc?.documentElement) return [];
  return elementChildren(doc.documentElement, MAIN_NS, "si").map(stringItemText);
}

// Built-in number formats that display a date or time.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormatCode(code: string): boolean {
  // Ignore quoted literals, escaped characters and colour/condition brackets,
  // then look for a day, month or year token.
  const stripped = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
  return /[dmy]/i.test(stripped);
}

/** For each cell style index, whether it formats its number as a date. */
function readDateStyles(parts: Parts): boolean[] {
  const doc = parseXml(parts, "xl/styles.xml");
  const root = doc?.documentElement;
  if (!root) return [];
  const customDate = new Map<number, boolean>();
  const numFmts = firstChild(root, MAIN_NS, "numFmts");
  if (numFmts) {
    for (const fmt of elementChildren(numFmts, MAIN_NS, "numFmt")) {
      const id = Number(fmt.getAttribute("numFmtId"));
      customDate.set(id, isDateFormatCode(fmt.getAttribute("formatCode") ?? ""));
    }
  }
  const cellXfs = firstChild(root, MAIN_NS, "cellXfs");
  if (!cellXfs) return [];
  return elementChildren(cellXfs, MAIN_NS, "xf").map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    return customDate.get(id) ?? BUILTIN_DATE_FORMATS.has(id);
  });
}

/** Excel serial date (1900 system) to an ISO date, with time if it has one. */
function serialToIso(serial: number): string {
  // Day 0 is 1899-12-30 once Excel's phantom 29 Feb 1900 is accounted for.
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const iso = new Date(ms).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

/** Zero-based column index from a cell reference such as "C12". */
function columnIndex(ref: string): number {
  let col = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    col = col * 26 + (code - 64);
  }
  return col - 1;
}

function cellValue(c: Element, shared: string[], dateStyles: boolean[]): string {
  const type = c.getAttribute("t") ?? "n";
  if (type === "inlineStr") {
    const is = firstChild(c, MAIN_NS, "is");
    return is ? stringItemText(is) : "";
  }
  const raw = firstChild(c, MAIN_NS, "v")?.textContent ?? "";
  if (raw === "") return "";
  switch (type) {
    case "s":
      return shared[Number(raw)] ?? "";
    case "b":
      return raw === "1" ? "true" : "false";
    case "str":
    case "e":
      return raw;
    default: {
      const style = Number(c.getAttribute("s") ?? 0);
      const num = Number(raw);
      if (dateStyles[style] && Number.isFinite(num)) return serialToIso(num);
      return raw;
    }
  }
}

function sheetRows(doc: Document, shared: string[], dateStyles: boolean[]): string[] {
  const root = doc.documentElement;
  const data = root ? firstChild(root, MAIN_NS, "sheetData") : undefined;
  if (!data) return [];
  const rows: string[] = [];
  for (const row of elementChildren(data, MAIN_NS, "row")) {
    const values: string[] = [];
    let next = 0;
    for (const c of elementChildren(row, MAIN_NS, "c")) {
      const ref = c.getAttribute("r");
      const col = ref ? columnIndex(ref) : next;
      while (values.length < col) values.push("");
      values[col] = cellValue(c, shared, dateStyles);
      next = col + 1;
    }
    while (values.length && values[values.length - 1] === "") values.pop();
    if (values.length) rows.push(values.join(","));
  }
  return rows;
}

/** Sheet names in workbook order, each with the zip path of its XML part. */
function readSheets(parts: Parts): { name: string; path: string }[] {
  const workbook = parseXml(parts, "xl/workbook.xml")?.documentElement;
  const rels = parseXml(parts, "xl/_rels/workbook.xml.rels")?.documentElement;
  if (!workbook || !rels) throw new Error("Not an Excel workbook (xl/workbook.xml missing)");
  const targets = new Map<string, string>();
  for (const rel of elementChildren(rels, PKG_REL_NS, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets = firstChild(workbook, MAIN_NS, "sheets");
  if (!sheets) return [];
  const out: { name: string; path: string }[] = [];
  for (const sheet of elementChildren(sheets, MAIN_NS, "sheet")) {
    const path = targets.get(sheet.getAttributeNS(REL_NS, "id") ?? "");
    if (path) out.push({ name: sheet.getAttribute("name") ?? "", path });
  }
  return out;
}

export function xlsxToText(buf: ArrayBuffer): string {
  const parts = unzipSync(new Uint8Array(buf));
  const shared = readSharedStrings(parts);
  const dateStyles = readDateStyles(parts);
  const out: string[] = [];
  for (const sheet of readSheets(parts)) {
    out.push(`# Sheet: ${sheet.name}`);
    const doc = parseXml(parts, sheet.path);
    if (doc) out.push(...sheetRows(doc, shared, dateStyles));
    out.push("");
  }
  return out.join("\n");
}
