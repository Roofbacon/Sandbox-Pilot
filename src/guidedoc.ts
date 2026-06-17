import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Build a guide document (Markdown, self-contained HTML, and/or PDF) from recorded steps.
// Steps are { n, caption, image } where image is a JPEG filename inside the guide dir.

export type GuideFormat = "markdown" | "html" | "pdf";

export interface GuideStep {
  n: number;
  caption: string;
  image: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMarkdown(title: string, steps: GuideStep[]): string {
  let md = `# ${title}\n\n`;
  for (const s of steps) {
    md += `## Step ${s.n}\n\n${s.caption}\n\n![Step ${s.n}](${s.image})\n\n`;
  }
  return md;
}

async function buildHtml(title: string, steps: GuideStep[], dir: string): Promise<string> {
  const parts: string[] = [];
  for (const s of steps) {
    let dataUri = "";
    try {
      const bytes = await fsp.readFile(path.join(dir, s.image));
      dataUri = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    } catch {
      // Missing image — render the caption without a picture rather than failing the whole doc.
    }
    parts.push(
      `<section class="step">\n` +
        `  <h2><span class="num">${s.n}</span> ${escapeHtml(s.caption)}</h2>\n` +
        (dataUri ? `  <img src="${dataUri}" alt="Step ${s.n}">\n` : "") +
        `</section>`,
    );
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: "Segoe UI", system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { border-bottom: 2px solid #888; padding-bottom: .3rem; }
  .step { margin: 2rem 0; }
  .step h2 { display: flex; align-items: center; gap: .6rem; font-size: 1.2rem; }
  .num { display: inline-flex; align-items: center; justify-content: center; min-width: 1.8rem; height: 1.8rem; border-radius: 50%; background: #2563eb; color: #fff; font-size: 1rem; }
  img { max-width: 100%; height: auto; border: 1px solid #ccc; border-radius: 6px; margin-top: .6rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${parts.join("\n")}
</body>
</html>
`;
}

function wrapText(text: string, font: any, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

async function buildPdf(title: string, steps: GuideStep[], dir: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const contentWidth = pageWidth - 2 * margin;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (needed: number) => {
    if (y - needed < margin) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  // Title
  for (const line of wrapText(title, bold, 20, contentWidth)) {
    page.drawText(line, { x: margin, y: y - 20, size: 20, font: bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 26;
  }
  y -= 10;

  for (const s of steps) {
    ensureSpace(40);
    const heading = `Step ${s.n}`;
    page.drawText(heading, { x: margin, y: y - 14, size: 14, font: bold, color: rgb(0.15, 0.39, 0.92) });
    y -= 22;

    for (const line of wrapText(s.caption, font, 11, contentWidth)) {
      ensureSpace(16);
      page.drawText(line, { x: margin, y: y - 11, size: 11, font });
      y -= 15;
    }
    y -= 6;

    try {
      const bytes = await fsp.readFile(path.join(dir, s.image));
      const jpg = await doc.embedJpg(bytes);
      const scale = Math.min(contentWidth / jpg.width, 1);
      const w = jpg.width * scale;
      const h = jpg.height * scale;
      ensureSpace(h + 10);
      page.drawImage(jpg, { x: margin, y: y - h, width: w, height: h });
      y -= h + 16;
    } catch {
      // Missing/invalid image — skip the picture.
    }
  }

  return doc.save();
}

export async function buildGuideDocs(opts: {
  title: string;
  steps: GuideStep[];
  dir: string;
  formats: GuideFormat[];
}): Promise<Record<string, string>> {
  const base = path.basename(opts.dir);
  const outputs: Record<string, string> = {};

  if (opts.formats.includes("markdown")) {
    const p = path.join(opts.dir, `${base}.md`);
    await fsp.writeFile(p, buildMarkdown(opts.title, opts.steps), "utf8");
    outputs.markdown = p;
  }
  if (opts.formats.includes("html")) {
    const p = path.join(opts.dir, `${base}.html`);
    await fsp.writeFile(p, await buildHtml(opts.title, opts.steps, opts.dir), "utf8");
    outputs.html = p;
  }
  if (opts.formats.includes("pdf")) {
    const p = path.join(opts.dir, `${base}.pdf`);
    await fsp.writeFile(p, await buildPdf(opts.title, opts.steps, opts.dir));
    outputs.pdf = p;
  }
  return outputs;
}
