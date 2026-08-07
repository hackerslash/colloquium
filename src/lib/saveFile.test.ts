import { describe, expect, it } from "vitest";
import { safeFileName } from "./saveFile";

describe("safeFileName", () => {
  it("keeps ordinary names intact", () => {
    expect(safeFileName("holiday photo.jpg")).toBe("holiday photo.jpg");
    expect(safeFileName("voice-1737000000.webm")).toBe("voice-1737000000.webm");
  });

  it("flattens separators so a peer can't redirect the save location", () => {
    // Dots survive, separators don't — which is all that traversal needs.
    expect(safeFileName("../../evil.exe")).toBe("_.._evil.exe");
    expect(safeFileName("a/b\\c.txt")).toBe("a_b_c.txt");
    // Drive letter loses both its colon and its separator, hence two underscores.
    expect(safeFileName("C:\\Windows\\System32\\x.dll")).toBe("C__Windows_System32_x.dll");
  });

  it("strips characters Windows rejects", () => {
    expect(safeFileName('re:port<1>?.txt')).toBe("re_port_1__.txt");
    expect(safeFileName("bell\x07.txt")).toBe("bell_.txt");
  });

  it("never returns an empty name", () => {
    expect(safeFileName("...")).toBe("download");
    expect(safeFileName("   ")).toBe("download");
    expect(safeFileName("/")).toBe("_");
  });
});
