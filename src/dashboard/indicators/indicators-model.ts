// The Indicators page's model (pure): a row per package, a package's details as its manifest describes them, and its
// README read as blocks of text (a small part of Markdown: headings, paragraphs, lists, tables, code; inline code and
// bold), drawn as elements, never as HTML.
import type { Manifest } from "../../shared/indicator-manifest.js";
import { twoTone, type PackageInfo } from "../charts/indicators.js";

export type PackageRow = { id: string; name: string; version: string; origin: "Bundled" | "Installed"; enabled: boolean; charts: string };

/** The packages in the server's order (bundled first, then installed ones by name). */
export function packageRows(packages: readonly PackageInfo[]): PackageRow[] {
  return packages.map(({ manifest, bundled, enabled, charts = 0 }) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    origin: bundled ? "Bundled" : "Installed",
    enabled,
    charts: charts === 0 ? "None" : charts === 1 ? "1 chart" : `${charts} charts`,
  }));
}

export type PackageDetails = {
  parameters: { label: string; range: string; default: string }[];
  outputs: { label: string; kind: string; placement: string }[];
};

export function packageDetails(manifest: Manifest): PackageDetails {
  return {
    parameters: manifest.parameters.map((p) => {
      if (p.type === "choice") return { label: p.label, range: p.choices.map((c) => c.label).join(", "), default: p.choices.find((c) => c.value === p.default)?.label ?? p.default };
      const below = p.lessThan === undefined ? "" : `, below ${manifest.parameters.find((o) => o.id === p.lessThan)?.label ?? p.lessThan}`;
      return { label: p.label, range: `${p.min}–${p.max}${below}`, default: String(p.default) };
    }),
    outputs: manifest.outputs.map((o) => ({
      label: o.label,
      kind: o.render === "line" ? "Line" : twoTone(o) ? "Histogram, rising and falling" : "Histogram",
      placement: o.placement === "overlay" ? "Price pane" : "Own pane",
    })),
  };
}

/** A run of text, perhaps inline code or bold. */
export type Inline = { text: string; code?: true; bold?: true };

export type Block =
  | { type: "heading"; level: number; text: Inline[] }
  | { type: "paragraph"; text: Inline[] }
  | { type: "list"; items: Inline[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "code"; text: string };

/** The README as blocks; anything else Markdown has reads as plain paragraphs. */
export function readmeBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: inline(heading[2]) });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && lines[i].trim(); i++) {
        // An indented line goes on with the item before it.
        if (/^\s*[-*]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
      }
      blocks.push({ type: "list", items: items.map(inline) });
      continue;
    }
    const text: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s+|\s*\|)/.test(lines[i]); i++) text.push(lines[i].trim());
    blocks.push({ type: "paragraph", text: inline(text.join(" ")) });
  }
  return blocks;
}

/** Inline code (`…`), bold (**…**) and links (<…> or [text](url), read as their text). */
function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<(https?:\/\/[^>]+)>/g, "$1");
  for (const part of plain.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.startsWith("`")) out.push({ text: part.slice(1, -1), code: true });
    else if (part.startsWith("**")) out.push({ text: part.slice(2, -2), bold: true });
    else out.push({ text: part.replace(/\*([^*]+)\*/g, "$1") });
  }
  return out;
}
