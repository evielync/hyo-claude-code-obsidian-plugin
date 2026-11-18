import test from "node:test";
import assert from "node:assert/strict";
import { textFileName } from "../src/attachments";

// Word and Excel files reach Claude as their extracted text. Saved as ".docx",
// Claude's Read tool refuses them as binary documents; ".md" reads.
test("extracted Word and Excel text is saved with a .md name", () => {
  assert.equal(textFileName("Brand Doc.docx"), "Brand Doc.docx.md");
  assert.equal(textFileName("Budget.XLSX"), "Budget.XLSX.md");
  assert.equal(textFileName("macro.xlsm"), "macro.xlsm.md");
});

test("text files keep their own name", () => {
  assert.equal(textFileName("notes.md"), "notes.md");
  assert.equal(textFileName("data.csv"), "data.csv");
  assert.equal(textFileName("script.ts"), "script.ts");
});
