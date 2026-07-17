import { useEffect, useState } from "react";
import { Hash, Phone } from "lucide-react";
import { useChatStore } from "../../stores/useChatStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import * as roomMembersRepo from "../../services/db/roomMembersRepo";
import * as roomService from "../../services/room/roomService";
import { MessageList } from "../chat/MessageList";
import { Composer } from "../chat/Composer";
import { RoomCallView } from "../call/RoomCallView";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

type GroupRoomViewProps = {
  roomId: string;
};

export function GroupRoomView({ roomId }: GroupRoomViewProps) {
  const self = useIdentityStore((s) => s.self);
  const room = useRoomStore((s) => s.roomsById[roomId]);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);

  const loadMessages = useChatStore((s) => s.loadMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setDraft = useChatStore((s) => s.setDraft);
  const messages = useChatStore((s) => s.messagesByRoom[roomId]);
  const draft = useChatStore((s) => s.draftByRoom[roomId]) ?? "";

  const callRoomId = useRoomCallStore((s) => s.roomId);
  const joinCall = useRoomCallStore((s) => s.join);
  const leaveCall = useRoomCallStore((s) => s.leave);
  const callParticipants = useRoomStore((s) => s.callParticipantsByRoom[roomId]) ?? [];
  const loadRooms = useRoomStore((s) => s.loadRooms);

  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const inThisCall = callRoomId === roomId;
  const inAnotherCall = callRoomId !== null && callRoomId !== roomId;
  const othersInCall = callParticipants.filter((id) => id !== self?.identityId);
  const callActive = inThisCall || othersInCall.length > 0;

  useEffect(() => {
    setActiveRoom(roomId);
    void loadMessages(roomId);
    void roomMembersRepo.listMembers(roomId).then(setMemberIds);
  }, [roomId, loadMessages, setActiveRoom]);

  function handleSend() {
    const others = memberIds.filter((id) => id !== self?.identityId);
    void sendMessage(roomId, others, draft);
  }

  async function handleLeaveRoom() {
    if (!self) return;
    if (inThisCall) leaveCall();
    await roomService.leaveRoom(self, roomId);
    await loadRooms();
  }

  if (!room) {
    return <EmptyState icon={Hash} title="Room not found" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Hash size={18} className="text-text-muted" aria-hidden="true" />
        <h1 className="text-sm font-semibold">{room.name ?? "Room"}</h1>
        <Badge>{memberIds.length} members</Badge>
        {callActive && !inThisCall && (
          <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
            {othersInCall.length} in call
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!inThisCall && (
            <Button
              size="sm"
              variant={callActive ? "primary" : "secondary"}
              icon={Phone}
              onClick={() => joinCall(roomId)}
              disabled={inAnotherCall}
              title={inAnotherCall ? "Leave your current call first" : "Join the voice/video room"}
              className={callActive ? "bg-success hover:bg-success/90" : undefined}
            >
              Join call
            </Button>
          )}
          {confirmingLeave ? (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="danger" onClick={() => void handleLeaveRoom()}>
                Leave room
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingLeave(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingLeave(true)}
              title="Leave this room"
            >
              Leave
            </Button>
          )}
        </div>
      </header>

      {inThisCall ? (
        <RoomCallView />
      ) : (
        <>
          <MessageList messages={messages} />
          <Composer
            value={draft}
            placeholder={`Message ${room.name ?? "the room"}`}
            onChange={(v) => setDraft(roomId, v)}
            onSend={handleSend}
          />
        </>
      )}
    </div>
  );
}
