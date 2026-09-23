import { getDocumentProxy } from "unpdf";

type Item = { str: string; x: number; y: number; w: number };

/**
 * A PDF's text as lines, top to bottom, page after page.
 *
 * pdf.js hands back positioned fragments, not lines. Fragments within two
 * points of the same baseline are one line; along it they are ordered by x, and
 * a gap wider than a point becomes one space. A fragment that starts where the
 * last one ended is the same word ("1," + "234.56"), which is what keeps an
 * amount in one piece for the parser.
 *
 * Its own entry point (`@lumpy/csv-import/pdf`) because pdf.js is most of a
 * megabyte: the web app loads it the first time someone picks a PDF, and the
 * CSV path never does. `unpdf` ships the build that needs no worker, so this is
 * the same code in the browser and under `bun test`.
 */
export async function pdfLines(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const out: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items) {
      if (!("str" in it) || it.str === "") continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width });
    }
    const rows: { y: number; items: Item[] }[] = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= 2);
      if (row) row.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y); // PDF y grows upward
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let line = "";
      let end = -Infinity;
      for (const it of row.items) {
        if (line !== "" && it.x - end > 1) line += " ";
        line += it.str;
        end = it.x + it.w;
      }
      const clean = line.replace(/\s+/g, " ").trim();
      if (clean) out.push(clean);
    }
  }
  return out;
}
