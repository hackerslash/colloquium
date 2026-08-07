import { describe, expect, it } from "vitest";
import { tileGrid } from "./tileGrid";

describe("tileGrid", () => {
  it("lays out the common call sizes", () => {
    expect(tileGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(tileGrid(2)).toEqual({ cols: 2, rows: 1 }); // side by side
    expect(tileGrid(3)).toEqual({ cols: 2, rows: 2 });
    expect(tileGrid(4)).toEqual({ cols: 2, rows: 2 });
    expect(tileGrid(6)).toEqual({ cols: 3, rows: 2 });
    expect(tileGrid(9)).toEqual({ cols: 3, rows: 3 });
  });

  it("always has enough cells for everyone", () => {
    for (let n = 1; n <= 50; n++) {
      const { cols, rows } = tileGrid(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      // and no wholly empty trailing row
      expect(cols * (rows - 1)).toBeLessThan(n);
    }
  });

  it("never emits a zero track, which would be invalid CSS", () => {
    for (const n of [0, -3, NaN]) {
      const { cols, rows } = tileGrid(n);
      expect(cols).toBeGreaterThanOrEqual(1);
      expect(rows).toBeGreaterThanOrEqual(1);
    }
  });
});
