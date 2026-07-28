/**
 * WebVTT text manipulation. Subtitle delay is applied here rather than by
 * re-running ffmpeg: shifting cues is pure string work, so a follower can match
 * the controller's delay instantly instead of tearing down its window.
 */

const CUE_TIME = /(\d{1,3}):(\d{2}):(\d{2})[.,](\d{3})|(\d{1,3}):(\d{2})[.,](\d{3})/;

function parseTimestamp(text: string): number | null {
  const m = CUE_TIME.exec(text);
  if (!m) return null;
  // Either the HH:MM:SS.mmm or the MM:SS.mmm alternative matched.
  if (m[1] !== undefined) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  }
  return Number(m[5]) * 60 + Number(m[6]) + Number(m[7]) / 1000;
}

function formatTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped / 60) % 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

type Shift = { kind: "keep" } | { kind: "drop" } | { kind: "line"; line: string };

function shiftTiming(line: string, deltaSec: number): Shift {
  const arrow = line.indexOf("-->");
  if (arrow < 0) return { kind: "keep" };
  const start = parseTimestamp(line.slice(0, arrow));
  const rest = line.slice(arrow + 3);
  const end = parseTimestamp(rest);
  if (start === null || end === null) return { kind: "keep" };
  if (end + deltaSec <= 0) return { kind: "drop" };
  // Cue settings (align, line, position…) follow the end timestamp and must
  // survive untouched.
  const endMatch = CUE_TIME.exec(rest);
  const settings = endMatch ? rest.slice(endMatch.index + endMatch[0].length) : "";
  return {
    kind: "line",
    line: `${formatTimestamp(start + deltaSec)} --> ${formatTimestamp(end + deltaSec)}${settings}`,
  };
}

/**
 * Shifts every cue in a WebVTT document by `deltaSec`.
 *
 * Only cue-timing lines are touched — anything else (the header, NOTE and STYLE
 * blocks, cue identifiers, the cue text itself) is passed through byte for byte,
 * so a payload that happens to look like a timestamp is never rewritten.
 *
 * A cue that ends before zero is dropped, identifier and text with it. The shift
 * is not only the user's delay: it also rebases source timestamps onto a remux
 * window's media clock, which can be a shift of thousands of seconds, and
 * clamping those would stack every earlier line onto the window's first frame. A
 * cue that merely straddles zero is still clamped, so a small negative delay
 * keeps showing the line it belongs to.
 */
export function shiftVtt(vtt: string, deltaSec: number): string {
  if (deltaSec === 0) return vtt;
  const blocks: string[] = [];
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes("-->"));
    const shifted = at < 0 ? { kind: "keep" as const } : shiftTiming(lines[at], deltaSec);
    if (shifted.kind === "drop") continue;
    if (shifted.kind === "line") lines[at] = shifted.line;
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * Converts SubRip to WebVTT. Done in TypeScript because it is a header, comma
 * decimal separators and cue numbering — not worth an ffmpeg round trip for a
 * file the user just picked from disk.
 */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => (line.includes("-->") ? line.replace(/,(\d{3})/g, ".$1") : line))
    .join("\n");
  return `WEBVTT\n\n${body.trimStart()}`;
}

/**
 * Converts SubStation Alpha to WebVTT. Styling, positioning and karaoke timing
 * are dropped — WebVTT cannot express them, which is the accepted trade for
 * showing the dialogue at all.
 *
 * Done here rather than by ffmpeg because the alternative is piping bytes
 * through a child process: the file is already in memory, and a pipe large
 * enough to deadlock is a real risk for a subtitle track with thousands of cues.
 */
export function assToVtt(ass: string): string {
  const lines = ass.replace(/^﻿/, "").split(/\r?\n/);
  // The Format: line declares field order, which varies between authoring
  // tools — reading it is the difference between correct cues and garbage.
  let fields: string[] = [];
  const cues: string[] = [];

  for (const line of lines) {
    const formatMatch = /^Format:\s*(.*)$/i.exec(line);
    if (formatMatch) {
      fields = formatMatch[1].split(",").map((f) => f.trim().toLowerCase());
      continue;
    }
    const dialogue = /^Dialogue:\s*(.*)$/i.exec(line);
    if (!dialogue || fields.length === 0) continue;

    const startAt = fields.indexOf("start");
    const endAt = fields.indexOf("end");
    const textAt = fields.indexOf("text");
    if (startAt < 0 || endAt < 0 || textAt < 0) continue;

    // Text is the final field and may itself contain commas, so only the fields
    // before it are split off.
    const parts = dialogue[1].split(",");
    const head = parts.slice(0, fields.length - 1);
    const text = parts.slice(fields.length - 1).join(",");
    const start = assTime(head[startAt]);
    const end = assTime(head[endAt]);
    if (start === null || end === null) continue;

    const body = text
      .replace(/\{[^}]*\}/g, "") // override tags
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .trim();
    if (!body) continue;
    cues.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${body}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** ASS timestamps are `H:MM:SS.cc` — centiseconds, and no zero padding on hours. */
function assTime(text: string | undefined): number | null {
  const m = /^\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*$/.exec(text ?? "");
  if (!m) return null;
  const frac = m[4].padEnd(2, "0").slice(0, 2);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(frac) / 100;
}

/** True if these bytes are already WebVTT, which must be passed through
 * unconverted — its cue text can legitimately contain `-->`-free markup that a
 * converter would mangle. */
export function looksLikeVtt(text: string): boolean {
  return text.replace(/^﻿/, "").trimStart().startsWith("WEBVTT");
}
