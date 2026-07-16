import { useCallStore } from "../../stores/useCallStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { VideoTile } from "./VideoTile";

function useRemoteName(remoteId: string | undefined): string {
  const contact = useRosterStore((s) => (remoteId ? s.contactsById[remoteId] : undefined));
  return contact?.displayName ?? "Unknown";
}

export function CallOverlay() {
  const activeCall = useCallStore((s) => s.activeCall);
  const localStream = useCallStore((s) => s.localStream);
  const remoteStream = useCallStore((s) => s.remoteStream);
  const micOn = useCallStore((s) => s.micOn);
  const camOn = useCallStore((s) => s.camOn);
  const connectionState = useCallStore((s) => s.connectionState);

  const acceptCall = useCallStore((s) => s.acceptCall);
  const declineCall = useCallStore((s) => s.declineCall);
  const hangUp = useCallStore((s) => s.hangUp);
  const toggleMic = useCallStore((s) => s.toggleMic);
  const toggleCam = useCallStore((s) => s.toggleCam);

  const remoteName = useRemoteName(activeCall?.remoteId);

  if (!activeCall) return null;

  if (activeCall.status === "incoming") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-80 rounded-2xl bg-bg-secondary p-6 text-center shadow-xl">
          <p className="text-lg font-semibold text-text-primary">{remoteName}</p>
          <p className="mt-1 text-sm text-text-secondary">Incoming call…</p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              onClick={declineCall}
              className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white"
            >
              Decline
            </button>
            <button
              onClick={acceptCall}
              className="rounded-lg bg-success px-4 py-2 text-sm font-medium text-white"
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    );
  }

  const statusLabel =
    activeCall.status === "outgoing"
      ? "Calling…"
      : activeCall.status === "connecting"
        ? "Connecting…"
        : connectionState === "connected"
          ? "Connected"
          : connectionState;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg-primary">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <p className="font-semibold text-text-primary">{remoteName}</p>
          <p className="text-xs text-text-secondary" role="status" aria-live="polite">
            {statusLabel}
          </p>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-auto p-6 md:grid-cols-2">
        <VideoTile
          stream={remoteStream}
          label={remoteName}
          hasVideo={(remoteStream?.getVideoTracks().length ?? 0) > 0}
        />
        <VideoTile
          stream={localStream}
          label="You"
          muted
          mirror
          hasVideo={camOn && (localStream?.getVideoTracks().length ?? 0) > 0}
        />
      </div>

      <footer className="flex items-center justify-center gap-3 border-t border-border py-4">
        <button
          onClick={toggleMic}
          aria-pressed={!micOn}
          className={`rounded-full px-4 py-2 text-sm font-medium ${
            micOn ? "bg-bg-tertiary text-text-primary" : "bg-danger text-white"
          }`}
        >
          {micOn ? "Mute" : "Unmute"}
        </button>
        <button
          onClick={toggleCam}
          aria-pressed={camOn}
          className={`rounded-full px-4 py-2 text-sm font-medium ${
            camOn ? "bg-accent text-white" : "bg-bg-tertiary text-text-primary"
          }`}
        >
          {camOn ? "Stop video" : "Start video"}
        </button>
        <button
          onClick={hangUp}
          className="rounded-full bg-danger px-4 py-2 text-sm font-medium text-white"
        >
          Leave
        </button>
      </footer>
    </div>
  );
}
