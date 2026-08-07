import { describe, expect, it } from "vitest";
import { tileColumn, tileGrid, tileTracks } from "./tileGrid";

describe("tileGrid", () => {
  it("lays out the common call sizes", () => {
    expect(tileGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(tileGrid(2)).toEqual({ cols: 2, rows: 1 }); // side by side
    expect(tileGrid(3)).toEqual({ cols: 2, rows: 2 });
    expect(tileGrid(4)).toEqual({ cols: 2, rows: 2 });
    expect(tileGrid(5)).toEqual({ cols: 3, rows: 2 });
    expect(tileGrid(6)).toEqual({ cols: 3, rows: 2 });
    expect(tileGrid(9)).toEqual({ cols: 3, rows: 3 });
  });

  it("takes an extra column when it fills the rectangle exactly", () => {
    expect(tileGrid(8)).toEqual({ cols: 4, rows: 2 }); // not 3x3 with a hole
    expect(tileGrid(10)).toEqual({ cols: 5, rows: 2 });
  });

  it("does not collapse a small call into one wide row", () => {
    // 3 divides into a 3x1, but tall narrow tiles beat a filled row here.
    expect(tileGrid(3).rows).toBe(2);
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

describe("tileTracks", () => {
  it("doubles the columns so tiles can be offset by half of one", () => {
    expect(tileTracks(2, 2)).toEqual({
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      gridTemplateRows: "repeat(2, minmax(0, 1fr))",
    });
  });
});

describe("tileColumn", () => {
  it("auto-places every tile when the grid is full", () => {
    for (let i = 0; i < 4; i++) expect(tileColumn(i, 4, 2)).toBe("auto / span 2");
  });

  it("centres a lone trailing tile", () => {
    // 3 in a 2-col grid: the third sits across the middle two sub-columns.
    expect(tileColumn(0, 3, 2)).toBe("auto / span 2");
    expect(tileColumn(1, 3, 2)).toBe("auto / span 2");
    expect(tileColumn(2, 3, 2)).toBe("2 / span 2");
  });

  it("centres a partly-filled trailing row", () => {
    // 5 in a 3-col grid: two tiles centred across 6 sub-columns.
    expect(tileColumn(3, 5, 3)).toBe("2 / span 2");
    expect(tileColumn(4, 5, 3)).toBe("auto / span 2"); // follows on
    // 7 in a 3-col grid: one tile, offset further to stay centred.
    expect(tileColumn(6, 7, 3)).toBe("3 / span 2");
  });

  it("leaves equal space on both sides of a short row", () => {
    for (let n = 1; n <= 40; n++) {
      const { cols } = tileGrid(n);
      const remainder = n % cols;
      if (remainder === 0) continue;
      const start = Number(tileColumn(n - remainder, n, cols).split(" / ")[0]);
      const before = start - 1;
      const after = cols * 2 - (before + remainder * 2);
      expect(before).toBe(after);
    }
  });
});
