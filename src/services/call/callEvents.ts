/** Call-lifecycle events for the UI layer (toasts). Services emit; the
 * toaster subscribes once at app boot. Kept as a tiny standalone emitter so
 * services don't import UI code. */

export type CallEvent =
  | { kind: "call-declined"; remoteId: string }
  | { kind: "call-busy"; remoteId: string }
  | { kind: "call-ended"; remoteId: string }
  | { kind: "call-lost"; remoteId: string }
  | { kind: "call-no-answer"; remoteId: string }
  | { kind: "call-missed"; remoteId: string }
  | { kind: "call-unreachable"; remoteId: string }
  | { kind: "call-blocked-in-room-call" }
  | { kind: "room-call-blocked-in-call" }
  | { kind: "room-participant-joined"; roomId: string; participantId: string }
  | { kind: "room-participant-left"; roomId: string; participantId: string };

type CallEventListener = (event: CallEvent) => void;

const listeners = new Set<CallEventListener>();

export function onCallEvent(listener: CallEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitCallEvent(event: CallEvent): void {
  listeners.forEach((listener) => listener(event));
}
