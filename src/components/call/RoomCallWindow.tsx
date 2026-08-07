import { Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from "lucide-react";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useWatchPartyStore } from "../../stores/useWatchPartyStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { VideoTile } from "./VideoTile";
import { CallControlBar } from "./CallControlBar";
import { ScreenShareButton } from "./ScreenShareButton";
import { ScreenQualityBadge } from "./ScreenQualityBadge";
import { FloatingCallWindow } from "./FloatingCallWindow";
import { IconButton } from "../ui/IconButton";
import type { ConnectionQuality } from "../../services/call/PeerConnectionWrapper";
import { hasLiveVideo } from "../../lib/mediaTracks";
import { tileColumn, tileGrid, tileTracks } from "./tileGrid";

function useNameLookup() {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  return (id: string) =>
    id === self?.identityId ? "You" : (contactsById[id]?.displayName ?? "Unknown");
}

export function RoomCallWindow() {
  const self = useIdentityStore((s) => s.self);
  const roomId = useRoomCallStore((s) => s.roomId);
  const room = useRoomStore((s) => (roomId ? s.roomsById[roomId] : undefined));
  const partyRoomId = useWatchPartyStore((s) => (s.active ? s.roomId : null));

  const participants = useRoomCallStore((s) => s.participants);
  const slots = useRoomCallStore((s) => s.slots);
  const streamsByParticipant = useRoomCallStore((s) => s.streamsByParticipant);
  const screenStreamsByParticipant = useRoomCallStore((s) => s.screenStreamsByParticipant);
  const qualityByParticipant = useRoomCallStore((s) => s.qualityByParticipant);
  const camOnByParticipant = useRoomCallStore((s) => s.camOnByParticipant);
  const watchingScreens = useRoomCallStore((s) => s.watchingScreens);
  const watchScreen = useRoomCallStore((s) => s.watchScreen);
  const unwatchScreen = useRoomCallStore((s) => s.unwatchScreen);
  const localStream = useRoomCallStore((s) => s.localStream);
  const micOn = useRoomCallStore((s) => s.micOn);
  const camOn = useRoomCallStore((s) => s.camOn);
  const screenOn = useRoomCallStore((s) => s.screenOn);
  const presentError = useRoomCallStore((s) => s.presentError);
  const speakingIds = useRoomCallStore((s) => s.speakingIds);
  useRoomCallStore((s) => s.mediaVersion);

  const leave = useRoomCallStore((s) => s.leave);
  const toggleMic = useRoomCallStore((s) => s.toggleMic);
  const toggleCam = useRoomCallStore((s) => s.toggleCam);
  const toggleScreenShare = useRoomCallStore((s) => s.toggleScreenShare);
  const screenConfig = useRoomCallStore((s) => s.screenConfig);
  const setScreenConfig = useRoomCallStore((s) => s.setScreenConfig);
  const screenLinkBps = useRoomCallStore((s) => s.screenLinkBps);

  const nameOf = useNameLookup();

  if (!roomId) return null;
  // A watch party for this room presents the call itself — cameras in its
  // presence rail, mic/cam/leave in its own chrome. Without this, joining from
  // the party puts a second copy of every tile in a floating window that sits
  // above the film (z-60 over the party's z-40).
  if (partyRoomId === roomId) return null;

  const holderIds = slots.map((s) => s.holderId).filter((id): id is string => id !== null);
  const slotsFull = !screenOn && holderIds.length >= 2;

  function mainStreamFor(id: string): MediaStream | null {
    if (id === self?.identityId) return localStream;
    return streamsByParticipant[id] ?? null;
  }

  // The stage is driven by slot claims, not received streams: a presenter
  // announces the share, and each viewer opts in ("Watch stream") before any
  // video flows to them.
  const presenters = slots
    .map((s) => (s.mediaKind === "screen" ? s.holderId : null))
    .filter((id): id is string => id !== null);
  const hasScreens = presenters.length > 0;

  function qualityFor(id: string): ConnectionQuality | undefined {
    if (id === self?.identityId) return undefined;
    return qualityByParticipant[id];
  }

  // Announced camera state (room_call_media_state) overrides track-mute
  // detection — WebKit doesn't reliably mute remote tracks when the sender
  // stops, which otherwise leaves a frozen last frame.
  function hasVideoFor(id: string, stream: MediaStream | null): boolean {
    if (id === self?.identityId) return camOn;
    return hasLiveVideo(stream) && camOnByParticipant[id] !== false;
  }

  const { cols, rows } = tileGrid(participants.length);

  const roomTitle = room?.name ? `#${room.name}` : "Room Meeting";
  const statusText = `${participants.length} participant${participants.length === 1 ? "" : "s"}`;

  const controls = (
    <CallControlBar>
      <IconButton
        icon={micOn ? Mic : MicOff}
        label={micOn ? "Mute" : "Unmute"}
        size="lg"
        variant={micOn ? "solid" : "danger"}
        onClick={toggleMic}
      />
      <IconButton
        icon={camOn ? Video : VideoOff}
        label={camOn ? "Stop camera" : "Start camera"}
        size="lg"
        variant={camOn ? "accent" : "solid"}
        onClick={() => void toggleCam()}
      />
      <ScreenShareButton
        screenOn={screenOn}
        disabled={slotsFull}
        onToggle={() => void toggleScreenShare()}
        label={slotsFull ? "Both screen-share slots are taken" : screenOn ? "Stop presenting" : "Present screen"}
      />
      <IconButton
        icon={PhoneOff}
        label="Leave"
        size="lg"
        variant="danger"
        tooltip={false}
        onClick={leave}
      />
    </CallControlBar>
  );

  return (
    <FloatingCallWindow
      title={roomTitle}
      statusLabel={statusText}
      statusDotColor="bg-success"
      onHangUp={leave}
      controls={controls}
    >
      {screenOn && (
        <div className="absolute right-3 top-3 z-30">
          <ScreenQualityBadge
            currentConfig={screenConfig}
            onConfigChange={setScreenConfig}
            linkBps={screenLinkBps}
          />
        </div>
      )}

      {hasScreens ? (
        <div className="flex min-h-0 flex-1 flex-col pb-20">
          {/* Screen stage */}
          <div className="flex min-h-0 flex-1 gap-3 p-3">
            {presenters.map((id) => {
              const stream = screenStreamsByParticipant[id];
              const isSelf = id === self?.identityId;
              const watching = isSelf || watchingScreens.has(id);
              const live = watching && stream && hasLiveVideo(stream);
              return (
                <div key={`screen-${id}`} className="relative min-h-0 min-w-0 flex-1">
                  {live ? (
                    <>
                      <VideoTile
                        stream={stream}
                        muted={isSelf}
                        label={`${nameOf(id)} (screen)`}
                        hasVideo
                        fit="fill"
                        speaking={speakingIds.has(id)}
                      />
                      {!isSelf && (
                        <button
                          onClick={() => unwatchScreen(id)}
                          className="absolute left-2 top-2 z-20 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                        >
                          Stop watching
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-lg bg-black ring-1 ring-border/50">
                      <MonitorUp size={28} className="text-text-secondary" aria-hidden="true" />
                      <p className="text-sm text-text-secondary">
                        {isSelf ? "Starting your stream…" : `${nameOf(id)} is presenting`}
                      </p>
                      {!isSelf &&
                        (watching ? (
                          <p className="text-xs text-text-muted">Connecting…</p>
                        ) : (
                          <button
                            onClick={() => watchScreen(id)}
                            className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover"
                          >
                            Watch stream
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Camera filmstrip under the stage */}
          <div className="flex h-24 shrink-0 gap-2 overflow-x-auto px-3 pb-1">
            {participants.map((id) => {
              const stream = mainStreamFor(id);
              return (
                <div key={id} className="aspect-video h-full shrink-0">
                  <VideoTile
                    stream={stream}
                    muted={id === self?.identityId}
                    mirror={id === self?.identityId}
                    label={nameOf(id)}
                    participantId={id}
                    quality={qualityFor(id)}
                    hasVideo={hasVideoFor(id, stream)}
                    speaking={speakingIds.has(id)}
                    avatarSize="md"
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        // Rows divide the window's height instead of inheriting it from tile
        // width, so the grid can't grow past the bottom edge no matter how many
        // people join. Tiles fill their cell and the video letterboxes inside.
        <div className="grid min-h-0 flex-1 gap-3 p-3 pb-20" style={tileTracks(cols, rows)}>
          {participants.map((id, i) => {
            const stream = mainStreamFor(id);
            return (
              <div
                key={id}
                className="min-h-0 min-w-0"
                style={{ gridColumn: tileColumn(i, participants.length, cols) }}
              >
                <VideoTile
                  stream={stream}
                  muted={id === self?.identityId}
                  mirror={id === self?.identityId}
                  label={nameOf(id)}
                  participantId={id}
                  quality={qualityFor(id)}
                  hasVideo={hasVideoFor(id, stream)}
                  speaking={speakingIds.has(id)}
                  fit="fill"
                />
              </div>
            );
          })}
        </div>
      )}

      {presentError && (
        <p role="alert" className="absolute bottom-24 left-4 right-4 text-center text-xs text-danger z-20">
          {presentError}
        </p>
      )}
    </FloatingCallWindow>
  );
}

export { RoomCallWindow as RoomCallView };
