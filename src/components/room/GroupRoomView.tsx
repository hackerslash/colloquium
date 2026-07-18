import { useEffect, useState } from "react";
import { Check, Edit2, Hash, Phone, UserPlus, X } from "lucide-react";
import { useChatStore } from "../../stores/useChatStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import * as roomMembersRepo from "../../services/db/roomMembersRepo";
import * as roomService from "../../services/room/roomService";
import { MessageList } from "../chat/MessageList";
import { Composer } from "../chat/Composer";
import { TypingIndicator } from "../chat/TypingIndicator";
import { notifyTyping, stopTyping } from "../../services/room/typingService";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { RoomMembersModal } from "./RoomMembersModal";
import { AddMembersModal } from "./AddMembersModal";
import { toast } from "../../stores/useToastStore";

type GroupRoomViewProps = {
  roomId: string;
  onLeft?: () => void;
};

export function GroupRoomView({ roomId, onLeft }: GroupRoomViewProps) {
  const self = useIdentityStore((s) => s.self);
  const room = useRoomStore((s) => s.roomsById[roomId]);
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom);
  const loadRooms = useRoomStore((s) => s.loadRooms);

  const loadMessages = useChatStore((s) => s.loadMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setDraft = useChatStore((s) => s.setDraft);
  const messages = useChatStore((s) => s.messagesByRoom[roomId]);
  const draft = useChatStore((s) => s.draftByRoom[roomId]) ?? "";

  const callRoomId = useRoomCallStore((s) => s.roomId);
  const joinCall = useRoomCallStore((s) => s.join);
  const callParticipants = useRoomStore((s) => s.callParticipantsByRoom[roomId]) ?? [];

  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);

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

  useEffect(() => {
    if (room?.name) setNewName(room.name);
  }, [room?.name]);

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

  async function handleRename() {
    if (!self || !room || !newName.trim() || renaming || newName.trim() === room.name) {
      setIsEditingName(false);
      return;
    }
    setRenaming(true);
    try {
      await roomService.renameGroupRoom(self, roomId, newName.trim());
      await loadRooms();
      toast.success("Space renamed", `Renamed space to "${newName.trim()}"`);
      setIsEditingName(false);
    } catch (err) {
      console.error("Failed to rename space:", err);
      toast.error("Failed to rename space", "Please try again.");
    } finally {
      setRenaming(false);
    }
  }

  if (!room) {
    return <EmptyState icon={Hash} title="Room not found" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {isEditingName ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRename();
            }}
            className="flex items-center gap-1.5"
          >
            <Hash size={18} className="text-text-muted" aria-hidden="true" />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={48}
              disabled={renaming}
              className="rounded-md border border-border-strong bg-bg-tertiary px-2 py-0.5 text-sm font-semibold text-text-primary outline-none focus:border-accent"
            />
            <IconButton
              icon={Check}
              label="Save name"
              size="sm"
              variant="accent"
              onClick={() => void handleRename()}
              disabled={!newName.trim() || renaming}
            />
            <IconButton
              icon={X}
              label="Cancel edit"
              size="sm"
              onClick={() => {
                setNewName(room.name ?? "");
                setIsEditingName(false);
              }}
            />
          </form>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-bg-tertiary"
              onClick={() => setMembersOpen(true)}
            >
              <Hash size={18} className="text-text-muted" aria-hidden="true" />
              <h1 className="text-sm font-semibold">{room.name ?? "Room"}</h1>
              <Badge>{memberIds.length} members</Badge>
            </button>
            <IconButton
              icon={Edit2}
              label="Rename space"
              size="sm"
              onClick={() => setIsEditingName(true)}
            />
            <IconButton
              icon={UserPlus}
              label="Add members"
              size="sm"
              onClick={() => setAddMembersOpen(true)}
            />
          </div>
        )}

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

      <MessageList messages={messages} roomId={roomId} />
      <TypingIndicator roomId={roomId} />
      <Composer
        value={draft}
        placeholder={`Message ${room.name ?? "the room"}`}
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

      <AddMembersModal
        open={addMembersOpen}
        onClose={() => setAddMembersOpen(false)}
        roomId={roomId}
        currentMemberIds={memberIds}
        onAdded={() => {
          void roomMembersRepo.listMembers(roomId).then(setMemberIds);
        }}
      />
    </div>
  );
}
