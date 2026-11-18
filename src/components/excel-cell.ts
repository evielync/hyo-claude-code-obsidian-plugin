import type { CellValue } from "exceljs";

/**
 * One spreadsheet cell as plain text, for an Excel attachment turned into
 * CSV. Rich text, hyperlinks, formulas and errors are objects in exceljs, so
 * each gives the text a person would see in the cell.
 */
export function cellText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object" || v instanceof Date) return String(v);
  if ("richText" in v) return v.richText.map((r) => r.text).join("");
  if ("hyperlink" in v) return v.text;
  if ("error" in v) return v.error;
  // A formula: what it worked out to, when exceljs has that.
  return v.result === undefined ? "" : cellText(v.result);
}
