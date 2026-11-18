import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { xlsxToText } from "../src/xlsx";

// Obsidian has DOMParser built in; plain Node needs one.
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = DOMParser;

// test/fixtures/sample.xlsx was written by ExcelJS (the library this reader
// replaced): shared strings, numbers, booleans, a formula, rich text, a
// date-formatted cell and an empty column.
test("reads every sheet of a workbook as CSV-style text", () => {
  const buf = readFileSync(join(process.cwd(), "test", "fixtures", "sample.xlsx"));
  const text = xlsxToText(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(
    text,
    [
      "# Sheet: Budget",
      "Item,Cost,Paid",
      "Rent,1200,true",
      "Food,350.5,false",
      "Total,1550.5,,rich text",
      "",
      "# Sheet: Dates",
      "When",
      "2026-11-18,,gap before",
      "",
    ].join("\n"),
  );
});

test("rejects a file that isn't a workbook", () => {
  assert.throws(() => xlsxToText(new Uint8Array([1, 2, 3]).buffer));
});
