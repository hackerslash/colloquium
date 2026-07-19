import { useEffect, useState } from "react";
import { Hash, Phone } from "lucide-react";
import { useChatStore } from "../../stores/useChatStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import * as roomMembersRepo from "../../services/db/roomMembersRepo";
import { MessageList } from "../chat/MessageList";
import { Composer } from "../chat/Composer";
import { TypingIndicator } from "../chat/TypingIndicator";
import { notifyTyping, stopTyping } from "../../services/room/typingService";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { RoomMembersModal } from "./RoomMembersModal";
import { toast } from "../../stores/useToastStore";

type GroupRoomViewProps = {
  roomId: string;
  onLeft?: () => void;
};

export function GroupRoomView({ roomId, onLeft }: GroupRoomViewProps) {
  const self = useIdentityStore((s) => s.self);
  const room = useRoomStore((s) => s.roomsById[roomId]);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);

  const loadMessages = useChatStore((s) => s.loadMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setDraft = useChatStore((s) => s.setDraft);
  const messages = useChatStore((s) => s.messagesByRoom[roomId]);
  const draft = useChatStore((s) => s.draftByRoom[roomId]) ?? "";
  const replyingTo = useChatStore((s) => s.replyingToByRoom[roomId]) ?? null;
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const contactsById = useRosterStore((s) => s.contactsById);

  const callRoomId = useRoomCallStore((s) => s.roomId);
  const joinCall = useRoomCallStore((s) => s.join);
  const callParticipants = useRoomStore((s) => s.callParticipantsByRoom[roomId]) ?? [];

  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);

  const inThisCall = callRoomId === roomId;
  const inAnotherCall = callRoomId !== null && callRoomId !== roomId;
  const othersInCall = callParticipants.filter((id) => id !== self?.identityId);
  const callActive = inThisCall || othersInCall.length > 0;

  useEffect(() => {
    setActiveRoom(roomId);
    void loadMessages(roomId);
    return () => {
      if (useRoomStore.getState().activeRoomId === roomId) setActiveRoom(null);
      stopTyping(roomId, memberIds);
    };
  }, [roomId, loadMessages, setActiveRoom]);

  useEffect(() => {
    let cancelled = false;
    void roomMembersRepo.listMembers(roomId).then((ids) => {
      if (!cancelled) setMemberIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, messages?.length]);

  async function handleSend(file?: File) {
    if (!room) return;
    let currentMembers = memberIds;
    try {
      currentMembers = await roomMembersRepo.listMembers(roomId);
      setMemberIds(currentMembers);
    } catch {
      // Fall back to last known
    }
    stopTyping(roomId, currentMembers);
    return sendMessage(roomId, currentMembers, draft, file).catch((err) => {
      console.error("Failed to send message:", err);
      toast.error("Message not sent", "Please try again.");
    });
  }

  if (!room) {
    return <EmptyState icon={Hash} title="Room not found" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <button
          type="button"
          className="flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-bg-tertiary"
          onClick={() => setMembersOpen(true)}
        >
          <Hash size={18} className="text-text-muted" aria-hidden="true" />
          <h1 className="text-sm font-semibold">{room.name ?? "Room"}</h1>
          <Badge>{memberIds.length} members</Badge>
        </button>

        {inThisCall && (
          <span className="flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-0.5 text-xs font-semibold text-success">
            <span className="h-2 w-2 rounded-full bg-success animate-pulse" aria-hidden="true" />
            Connected to call
          </span>
        )}

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
        </div>
      </header>

      <MessageList messages={messages} roomId={roomId} memberIds={memberIds} />
      <TypingIndicator roomId={roomId} />
      <Composer
        value={draft}
        placeholder={`Message ${room.name ?? "the room"}`}
        replyingTo={
          replyingTo && {
            id: replyingTo.id,
            authorName:
              replyingTo.authorId === self?.identityId
                ? self.displayName
                : contactsById[replyingTo.authorId]?.displayName ?? "Unknown",
            snippet: replyingTo.body || replyingTo.attachmentName || "Attachment",
          }
        }
        onCancelReply={() => setReplyingTo(roomId, null)}
        onChange={(v) => {
          setDraft(roomId, v);
          if (v) notifyTyping(roomId, memberIds);
          else stopTyping(roomId, memberIds);
        }}
        onSend={handleSend}
      />

      <RoomMembersModal
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        roomId={roomId}
        onLeft={() => onLeft?.()}
      />
    </div>
  );
}
