import { describe, expect, it, vi } from "vitest";
import { primeDevicePermission } from "./devicePermissions";

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function withGetUserMedia(impl: (c: MediaStreamConstraints) => Promise<MediaStream>) {
  const getUserMedia = vi.fn(impl);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

describe("primeDevicePermission", () => {
  it("releases the tracks it opened and doesn't ask twice when both devices work", async () => {
    const { stream, track } = fakeStream();
    const getUserMedia = withGetUserMedia(async () => stream);

    await primeDevicePermission();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(track.stop).toHaveBeenCalled();
  });

  it("falls back to audio-only when the camera is unavailable", async () => {
    const { stream, track } = fakeStream();
    const getUserMedia = withGetUserMedia(async (c) => {
      if (c.video) throw new Error("NotFoundError");
      return stream;
    });

    await primeDevicePermission();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
    expect(track.stop).toHaveBeenCalled();
  });

  it("resolves rather than throwing when everything is denied", async () => {
    withGetUserMedia(async () => {
      throw new Error("NotAllowedError");
    });

    await expect(primeDevicePermission()).resolves.toBeUndefined();
  });
});
