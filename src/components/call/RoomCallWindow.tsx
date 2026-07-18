import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { VideoTile } from "./VideoTile";
import { CallControlBar } from "./CallControlBar";
import { ScreenShareButton } from "./ScreenShareButton";
import { ScreenQualityBadge } from "./ScreenQualityBadge";
import { FloatingCallWindow } from "./FloatingCallWindow";
import { IconButton } from "../ui/IconButton";
import type { ConnectionQuality } from "../../services/call/PeerConnectionWrapper";
import { QUALITY_DOT } from "./qualityDot";
import { hasLiveVideo } from "../../lib/mediaTracks";

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

  const participants = useRoomCallStore((s) => s.participants);
  const slots = useRoomCallStore((s) => s.slots);
  const streamsByParticipant = useRoomCallStore((s) => s.streamsByParticipant);
  const screenStreamsByParticipant = useRoomCallStore((s) => s.screenStreamsByParticipant);
  const qualityByParticipant = useRoomCallStore((s) => s.qualityByParticipant);
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

  const holderIds = slots.map((s) => s.holderId).filter((id): id is string => id !== null);
  const slotsFull = !screenOn && holderIds.length >= 2;

  function mainStreamFor(id: string): MediaStream | null {
    if (id === self?.identityId) return localStream;
    return streamsByParticipant[id] ?? null;
  }

  const screenShares = Object.entries(screenStreamsByParticipant);
  const hasScreens = screenShares.length > 0;

  function dotFor(id: string): string {
    if (id === self?.identityId) return "bg-success";
    return QUALITY_DOT[qualityByParticipant[id] ?? "unknown"];
  }

  function qualityFor(id: string): ConnectionQuality | undefined {
    if (id === self?.identityId) return undefined;
    return qualityByParticipant[id];
  }

  const gridCols =
    participants.length <= 1
      ? "grid-cols-1"
      : participants.length <= 4
        ? "grid-cols-1 md:grid-cols-2"
        : "grid-cols-2 md:grid-cols-3";

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
            {screenShares.map(([id, stream]) => (
              <div key={`screen-${id}`} className="min-h-0 min-w-0 flex-1">
                <VideoTile
                  stream={stream}
                  muted={id === self?.identityId}
                  label={`${nameOf(id)} (screen)`}
                  hasVideo={hasLiveVideo(stream)}
                  fit="fill"
                  speaking={speakingIds.has(id)}
                />
              </div>
            ))}
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
                    hasVideo={id === self?.identityId ? camOn : hasLiveVideo(stream)}
                    speaking={speakingIds.has(id)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={`grid flex-1 content-center gap-3 overflow-auto p-3 pb-20 ${gridCols}`}>
          {participants.map((id) => {
            const stream = mainStreamFor(id);
            return (
              <VideoTile
                key={id}
                stream={stream}
                muted={id === self?.identityId}
                mirror={id === self?.identityId}
                label={nameOf(id)}
                participantId={id}
                quality={qualityFor(id)}
                hasVideo={id === self?.identityId ? camOn : hasLiveVideo(stream)}
                speaking={speakingIds.has(id)}
              />
            );
          })}
        </div>
      )}

      {/* Participant strip */}
      <div className="absolute bottom-20 left-4 right-4 flex gap-1.5 overflow-x-auto pointer-events-auto z-20">
        {participants.map((id) => (
          <span
            key={id}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-bg-tertiary/90 backdrop-blur-sm px-2.5 py-1 text-xs shadow-sm"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dotFor(id)}`} aria-hidden="true" />
            {nameOf(id)}
            {screenStreamsByParticipant[id] && (
              <span className="font-medium text-accent">LIVE</span>
            )}
          </span>
        ))}
      </div>

      {presentError && (
        <p role="alert" className="absolute bottom-16 left-4 right-4 text-center text-xs text-danger z-20">
          {presentError}
        </p>
      )}
    </FloatingCallWindow>
  );
}

export { RoomCallWindow as RoomCallView };
