import { LogOut, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { VideoTile } from "../call/VideoTile";
import { ChromeButton } from "./PlayerChrome";
import { hasLiveVideo } from "../../lib/mediaTracks";
import { cx } from "../../lib/cx";

/**
 * Cameras as a floating column on the film rather than a fixed band beneath it.
 * The old strip took 112px of height from the picture for its whole life,
 * whether or not anyone had a camera on; this rides over the letterbox and
 * the viewer can dismiss it outright.
 */
export function PresenceRail({ roomId, visible }: { roomId: string | null; visible: boolean }) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);

  const callRoomId = useRoomCallStore((s) => s.roomId);
  const participants = useRoomCallStore((s) => s.participants);
  const streams = useRoomCallStore((s) => s.streamsByParticipant);
  const camOnByParticipant = useRoomCallStore((s) => s.camOnByParticipant);
  const localStream = useRoomCallStore((s) => s.localStream);
  const micOn = useRoomCallStore((s) => s.micOn);
  const camOn = useRoomCallStore((s) => s.camOn);
  useRoomCallStore((s) => s.mediaVersion);

  const inCall = callRoomId === roomId;
  const remotes = participants.filter((id) => id !== self?.identityId);

  return (
    <div
      className={cx(
        "pointer-events-none absolute top-3 right-3 bottom-24 z-10 flex w-40 flex-col items-end gap-2 transition-[opacity,visibility] duration-200 motion-reduce:transition-none",
        visible ? "opacity-100" : "invisible opacity-0",
      )}
    >
      {!inCall ? (
        <button
          type="button"
          onClick={() => roomId && void useRoomCallStore.getState().join(roomId)}
          className="pointer-events-auto flex w-full items-center gap-2 rounded-xl bg-black/55 px-3 py-2.5 text-left text-xs font-medium text-white/90 ring-1 ring-white/10 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
        >
          <Video size={15} aria-hidden="true" className="shrink-0 text-accent" />
          Join with camera &amp; mic
        </button>
      ) : (
        <>
          <div className="pointer-events-auto flex min-h-0 w-full flex-col gap-2 overflow-y-auto">
            <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10">
              <VideoTile
                stream={localStream}
                muted
                mirror
                label={self?.displayName ? `${self.displayName} (You)` : "You"}
                hasVideo={camOn}
                fit="grid"
                participantId={self?.identityId}
                avatarSize="md"
              />
            </div>
            {remotes.map((id) => (
              <div
                key={id}
                className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10"
              >
                <VideoTile
                  stream={streams[id] ?? null}
                  label={contactsById[id]?.displayName ?? "Guest"}
                  // Fail open, as RoomCallWindow does: a missing flag means we
                  // haven't heard yet, not that the camera is off.
                  hasVideo={hasLiveVideo(streams[id] ?? null) && camOnByParticipant[id] !== false}
                  fit="grid"
                  participantId={id}
                  avatarSize="md"
                />
              </div>
            ))}
          </div>

          <div className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-full bg-black/55 p-1 ring-1 ring-white/10 backdrop-blur-md">
            <ChromeButton
              icon={micOn ? Mic : MicOff}
              label={micOn ? "Mute" : "Unmute"}
              onClick={() => useRoomCallStore.getState().toggleMic()}
              className={cx(!micOn && "text-danger hover:text-danger")}
            />
            <ChromeButton
              icon={camOn ? Video : VideoOff}
              label={camOn ? "Turn camera off" : "Turn camera on"}
              onClick={() => void useRoomCallStore.getState().toggleCam()}
            />
            <ChromeButton
              icon={LogOut}
              label="Leave call"
              onClick={() => useRoomCallStore.getState().leave()}
            />
          </div>
        </>
      )}
    </div>
  );
}
