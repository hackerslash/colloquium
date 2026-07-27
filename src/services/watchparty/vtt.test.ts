import { describe, expect, it } from "vitest";
import { assToVtt, looksLikeVtt, shiftVtt, srtToVtt } from "./vtt";

const SAMPLE = [
  "WEBVTT",
  "",
  "1",
  "00:00:10.500 --> 00:00:13.000",
  "Hello there.",
  "",
  "2",
  "00:01:02.250 --> 00:01:04.750 line:90% align:center",
  "General Kenobi.",
  "",
].join("\n");

describe("shiftVtt", () => {
  it("shifts every cue forward", () => {
    const out = shiftVtt(SAMPLE, 2);
    expect(out).toContain("00:00:12.500 --> 00:00:15.000");
    expect(out).toContain("00:01:04.250 --> 00:01:06.750");
  });

  it("shifts backward and clamps at zero rather than dropping the cue", () => {
    const out = shiftVtt(SAMPLE, -12);
    expect(out).toContain("00:00:00.000 --> 00:00:01.000");
  });

  it("preserves cue settings after the end timestamp", () => {
    expect(shiftVtt(SAMPLE, 1)).toContain("line:90% align:center");
  });

  it("leaves the header, identifiers and cue text alone", () => {
    const out = shiftVtt(SAMPLE, 5);
    expect(out.startsWith("WEBVTT")).toBe(true);
    expect(out).toContain("Hello there.");
    expect(out).toContain("General Kenobi.");
    expect(out).toContain("\n1\n");
  });

  it("is a no-op at zero delay", () => {
    expect(shiftVtt(SAMPLE, 0)).toBe(SAMPLE);
  });

  it("does not rewrite cue text that looks like a timestamp", () => {
    // Only lines containing `-->` are timing lines; dialogue mentioning a clock
    // must survive untouched.
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMeet me at 00:10:00.000\n";
    const out = shiftVtt(vtt, 1);
    expect(out).toContain("Meet me at 00:10:00.000");
    expect(out).toContain("00:00:02.000 --> 00:00:03.000");
  });

  it("accepts the MM:SS.mmm short form ffmpeg emits", () => {
    const out = shiftVtt("WEBVTT\n\n01:02.500 --> 01:04.000\nHi\n", 1.5);
    expect(out).toContain("00:01:04.000 --> 00:01:05.500");
  });

  it("handles sub-second and fractional delays", () => {
    const out = shiftVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", 0.25);
    expect(out).toContain("00:00:01.250 --> 00:00:02.250");
  });

  it("keeps hours past the first", () => {
    const out = shiftVtt("WEBVTT\n\n01:59:59.500 --> 02:00:01.000\nHi\n", 1);
    expect(out).toContain("02:00:00.500 --> 02:00:02.000");
  });

  it("leaves NOTE and STYLE blocks untouched", () => {
    const vtt = "WEBVTT\n\nNOTE this is a note\n\nSTYLE\n::cue { color: red }\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
    const out = shiftVtt(vtt, 1);
    expect(out).toContain("NOTE this is a note");
    expect(out).toContain("::cue { color: red }");
  });
});

describe("srtToVtt", () => {
  it("adds the header and converts comma separators", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nHi\n";
    const out = srtToVtt(srt);
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(out).toContain("00:00:01.000 --> 00:00:02.500");
  });

  it("does not touch commas in the cue text", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nWell, hello, there\n";
    expect(srtToVtt(srt)).toContain("Well, hello, there");
  });

  it("strips a byte-order mark", () => {
    expect(srtToVtt("﻿1\n00:00:01,000 --> 00:00:02,000\nHi\n").startsWith("WEBVTT")).toBe(true);
  });

  it("round-trips through a shift", () => {
    const out = shiftVtt(srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHi\n"), 3);
    expect(out).toContain("00:00:04.000 --> 00:00:05.000");
  });
});

describe("assToVtt", () => {
  const ASS = [
    "[Script Info]",
    "Title: Example",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello there",
    "Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\i1}Italic{\\i0} and, a comma",
    "Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,Line one\\NLine two",
  ].join("\n");

  it("converts dialogue with centisecond timestamps", () => {
    const out = assToVtt(ASS);
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(out).toContain("00:00:01.000 --> 00:00:03.500");
    expect(out).toContain("Hello there");
  });

  it("strips override tags but keeps commas in the text", () => {
    // Text is the last field and may contain commas; splitting naively would
    // truncate the line.
    const out = assToVtt(ASS);
    expect(out).toContain("Italic and, a comma");
    expect(out).not.toContain("\\i1");
  });

  it("turns hard line breaks into real newlines", () => {
    expect(assToVtt(ASS)).toContain("Line one\nLine two");
  });

  it("honours a reordered Format line", () => {
    const reordered = [
      "[Events]",
      "Format: Start, End, Style, Text",
      "Dialogue: 0:00:09.00,0:00:10.00,Default,Reordered",
    ].join("\n");
    const out = assToVtt(reordered);
    expect(out).toContain("00:00:09.000 --> 00:00:10.000");
    expect(out).toContain("Reordered");
  });

  it("skips lines it cannot time and produces a valid empty document", () => {
    const out = assToVtt("[Events]\nFormat: Start, End, Text\nDialogue: bad,worse,nope\n");
    expect(out).toBe("WEBVTT\n\n\n");
  });

  it("shifts cleanly after conversion", () => {
    expect(shiftVtt(assToVtt(ASS), 2)).toContain("00:00:03.000 --> 00:00:05.500");
  });
});

describe("looksLikeVtt", () => {
  it("detects WebVTT, including with a byte-order mark", () => {
    expect(looksLikeVtt("WEBVTT\n\n")).toBe(true);
    expect(looksLikeVtt("﻿WEBVTT\n")).toBe(true);
  });

  it("rejects SubRip and ASS", () => {
    expect(looksLikeVtt("1\n00:00:01,000 --> 00:00:02,000\nHi\n")).toBe(false);
    expect(looksLikeVtt("[Script Info]\nTitle: x\n")).toBe(false);
  });
});
