import { motion } from "motion/react";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { useCallStore } from "../../stores/useCallStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { VideoTile } from "./VideoTile";
import { CallControlBar } from "./CallControlBar";
import { ScreenShareButton } from "./ScreenShareButton";
import { ScreenQualityBadge } from "./ScreenQualityBadge";
import { IconButton } from "../ui/IconButton";
import { Avatar } from "../ui/Avatar";
import { cx } from "../../lib/cx";
import { QUALITY_DOT } from "./qualityDot";
import { hasLiveVideo } from "../../lib/mediaTracks";
import { useRingtone } from "../../hooks/useRingtone";

function useRemoteName(remoteId: string | undefined): string {
  const contact = useRosterStore((s) => (remoteId ? s.contactsById[remoteId] : undefined));
  return contact?.displayName ?? "Unknown";
}

export function CallOverlay() {
  const activeCall = useCallStore((s) => s.activeCall);
  const localStream = useCallStore((s) => s.localStream);
  const remoteStream = useCallStore((s) => s.remoteStream);
  const remoteScreenStream = useCallStore((s) => s.remoteScreenStream);
  // Subscribe to mediaVersion so a track mute/unmute re-renders the tiles (their
  // <video> reattaches srcObject) without remounting them via a changing key —
  // a key change destroys the element, black-flashing and dropping tile state.
  useCallStore((s) => s.mediaVersion);
  const micOn = useCallStore((s) => s.micOn);
  const camOn = useCallStore((s) => s.camOn);
  const screenOn = useCallStore((s) => s.screenOn);
  const screenError = useCallStore((s) => s.screenError);
  const connectionState = useCallStore((s) => s.connectionState);
  const quality = useCallStore((s) => s.quality);

  const acceptCall = useCallStore((s) => s.acceptCall);
  const declineCall = useCallStore((s) => s.declineCall);
  const hangUp = useCallStore((s) => s.hangUp);
  const toggleMic = useCallStore((s) => s.toggleMic);
  const toggleCam = useCallStore((s) => s.toggleCam);
  const toggleScreenShare = useCallStore((s) => s.toggleScreenShare);
  const screenConfig = useCallStore((s) => s.screenConfig);
  const setScreenConfig = useCallStore((s) => s.setScreenConfig);
  const screenLinkBps = useCallStore((s) => s.screenLinkBps);
  const self = useIdentityStore((s) => s.self);
  const speakingIds = useCallStore((s) => s.speakingIds);

  const remoteName = useRemoteName(activeCall?.remoteId);

  useRingtone(
    activeCall?.status === "incoming" 
      ? "incoming" 
      : activeCall?.status === "ringing" 
        ? "outgoing" 
        : null
  );

  if (!activeCall) return null;

  if (activeCall.status === "incoming") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
        <div className="w-80 rounded-2xl border border-border bg-bg-elevated p-6 text-center shadow-modal">
          <div className="relative mx-auto flex h-20 w-20 items-center justify-center">
            <motion.span
              className="absolute inset-0 rounded-full border-2 border-accent motion-reduce:hidden"
              animate={{ scale: [1, 1.15, 1], opacity: [0.7, 0, 0.7] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
              aria-hidden="true"
            />
            {activeCall.remoteId && (
              <Avatar id={activeCall.remoteId} name={remoteName} size="xl" />
            )}
          </div>
          <p className="mt-4 text-lg font-semibold text-text-primary">{remoteName}</p>
          <p className="mt-1 text-sm text-text-secondary">
            Incoming {activeCall.withVideo ? "video" : "voice"} call…
          </p>
          <div className="mt-6 flex items-center justify-center gap-8">
            <div className="flex flex-col items-center gap-1.5">
              <IconButton
                icon={PhoneOff}
                label="Decline"
                size="lg"
                variant="danger"
                tooltip={false}
                onClick={declineCall}
              />
              <span className="text-xs text-text-secondary">Decline</span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <button
                onClick={acceptCall}
                aria-label="Accept"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-success text-white hover:opacity-90"
              >
                <Phone size={22} aria-hidden="true" />
              </button>
              <span className="text-xs text-text-secondary">Accept</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const reconnecting =
    activeCall.status === "active" &&
    (connectionState === "disconnected" || connectionState === "failed");

  const statusLabel =
    activeCall.status === "dialing"
      ? `Reaching ${remoteName}…`
      : activeCall.status === "outgoing"
        ? "Calling…"
        : activeCall.status === "ringing"
          ? "Ringing…"
          : activeCall.status === "connecting"
            ? "Connecting…"
            : reconnecting
              ? "Reconnecting…"
              : connectionState === "connected"
                ? "Connected"
                : connectionState;

  const localHasVideo = (camOn || screenOn) && (localStream?.getVideoTracks().length ?? 0) > 0;
  // Remote screen takes the stage; the remote camera/mic tile then moves to a
  // small tile but stays mounted — unmounting it would silence their mic.
  const remoteScreenLive = hasLiveVideo(remoteScreenStream);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg-primary">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-6">
        <p className="text-sm font-semibold text-text-primary">{remoteName}</p>
        <p
          className="flex items-center gap-1.5 text-xs text-text-secondary"
          role="status"
          aria-live="polite"
        >
          {activeCall.status === "active" && !reconnecting && (
            <span className={cx("h-2 w-2 rounded-full", QUALITY_DOT[quality])} aria-hidden="true" />
          )}
          {statusLabel}
        </p>
      </header>
      {reconnecting && (
        <div className="bg-warning/10 py-1.5 text-center text-xs text-warning" role="status">
          Connection interrupted — trying to reconnect…
        </div>
      )}
      {screenError && (
        <div className="bg-danger/10 py-1.5 text-center text-xs text-danger" role="alert">
          {screenError}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-6 pb-28">
        {screenOn && (
          <div className="absolute right-4 top-4 z-30">
            <ScreenQualityBadge
              currentConfig={screenConfig}
              onConfigChange={setScreenConfig}
              quality={quality}
              linkBps={screenLinkBps}
            />
          </div>
        )}
        <div className="h-full w-full max-w-5xl">
          {remoteScreenLive ? (
            <VideoTile
              stream={remoteScreenStream}
              label={`${remoteName} (screen)`}
              participantId={activeCall.remoteId}
              hasVideo
              quality={quality}
              fit="fill"
            />
          ) : (
            <VideoTile
              stream={remoteStream}
              label={remoteName}
              participantId={activeCall.remoteId}
              hasVideo={hasLiveVideo(remoteStream)}
              quality={quality}
              fit="fill"
              speaking={speakingIds.has(activeCall.remoteId)}
            />
          )}
        </div>
        {/* Remote camera/mic picture-in-picture while their screen has the stage */}
        {remoteScreenLive && (
          <div className="absolute bottom-[16.5rem] right-6 h-32 w-48">
            <VideoTile
              stream={remoteStream}
              label={remoteName}
              participantId={activeCall.remoteId}
              hasVideo={hasLiveVideo(remoteStream)}
              speaking={speakingIds.has(activeCall.remoteId)}
            />
          </div>
        )}
        {/* Local picture-in-picture */}
        <div className="absolute bottom-28 right-6 h-32 w-48">
          <VideoTile
            stream={localStream}
            label={screenOn ? "You (screen)" : "You"}
            muted
            mirror={!screenOn}
            hasVideo={localHasVideo}
            speaking={self ? speakingIds.has(self.identityId) : false}
          />
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
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
            label={camOn ? "Stop video" : "Start video"}
            size="lg"
            variant={camOn ? "accent" : "solid"}
            onClick={toggleCam}
          />
          {activeCall.status === "active" && (
            <ScreenShareButton screenOn={screenOn} onToggle={() => void toggleScreenShare()} />
          )}
          <IconButton
            icon={PhoneOff}
            label="Leave"
            size="lg"
            variant="danger"
            tooltip={false}
            onClick={hangUp}
          />
        </CallControlBar>
      </div>
    </div>
  );
}
