import { onCallEvent, type CallEvent } from "./callEvents";
import { toast } from "../../stores/useToastStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useCallStore } from "../../stores/useCallStore";

function nameOf(id: string): string {
  return useRosterStore.getState().contactsById[id]?.displayName ?? "Someone";
}

function roomName(roomId: string): string {
  return useRoomStore.getState().roomsById[roomId]?.name ?? "the room";
}

function handle(event: CallEvent) {
  switch (event.kind) {
    case "call-declined":
      toast.info(`${nameOf(event.remoteId)} declined the call`);
      break;
    case "call-busy":
      toast.info(`${nameOf(event.remoteId)} is busy`);
      break;
    case "call-ended":
      toast.info("Call ended");
      break;
    case "call-lost":
      toast.warning(`Lost connection to ${nameOf(event.remoteId)}`, "The call ended.");
      break;
    case "call-no-answer":
      toast.info(`${nameOf(event.remoteId)} didn't answer`);
      break;
    case "call-missed":
      toast.warning(`Missed call from ${nameOf(event.remoteId)}`);
      break;
    case "call-unreachable":
      toast.error(`Couldn't reach ${nameOf(event.remoteId)}`, "They appear to be offline.");
      break;
    case "call-blocked-in-room-call":
      toast.warning("You're in a room call", "Leave it before starting a direct call.");
      break;
    case "room-call-blocked-in-call": {
      const busyWith = useCallStore.getState().activeCall?.remoteId;
      toast.warning(
        "You're already in a call",
        busyWith ? `Leave your call with ${nameOf(busyWith)} first.` : undefined,
      );
      break;
    }
    case "room-participant-joined":
      toast.info(`${nameOf(event.participantId)} joined ${roomName(event.roomId)}`);
      break;
    case "room-participant-left":
      toast.info(`${nameOf(event.participantId)} left the call`);
      break;
  }
}

let started = false;

/** Subscribes call-lifecycle events to the toast surface. Call once at boot. */
export function startCallToastBridge(): () => void {
  if (started) return () => {};
  started = true;
  const unsub = onCallEvent(handle);
  return () => {
    started = false;
    unsub();
  };
}
