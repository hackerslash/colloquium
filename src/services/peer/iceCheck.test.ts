import { describe, it, expect } from "vitest";
import { parseCandidateType } from "./iceCheck";

describe("parseCandidateType", () => {
  it("extracts the type token from a real candidate line", () => {
    const relay =
      "candidate:1 1 udp 41885439 15.235.47.158 51234 typ relay raddr 0.0.0.0 rport 0";
    expect(parseCandidateType(relay)).toBe("relay");
    expect(parseCandidateType("candidate:0 1 udp 2113 192.168.1.2 5000 typ host")).toBe("host");
    expect(parseCandidateType("candidate:2 1 udp 169 1.2.3.4 5000 typ srflx raddr ...")).toBe(
      "srflx",
    );
  });

  it("returns null when no typ token is present", () => {
    expect(parseCandidateType("garbage")).toBeNull();
  });
});
