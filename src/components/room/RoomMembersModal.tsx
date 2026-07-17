import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import * as roomMembersRepo from "../../services/db/roomMembersRepo";
import * as roomService from "../../services/room/roomService";
import * as friendRequestService from "../../services/roster/friendRequestService";
import type { RoomMemberWire } from "../../types/wire";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/IconButton";

type RoomMembersModalProps = {
  open: boolean;
  onClose: () => void;
  roomId: string;
  onLeft: () => void;
};

export function RoomMembersModal({ open, onClose, roomId, onLeft }: RoomMembersModalProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const presenceById = useRosterStore((s) => s.presenceById);
  const loadRooms = useRoomStore((s) => s.loadRooms);
  const callRoomId = useRoomCallStore((s) => s.roomId);
  const leaveCall = useRoomCallStore((s) => s.leave);

  const [members, setMembers] = useState<RoomMemberWire[]>([]);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void roomMembersRepo.listMembersFull(roomId).then((all) => {
      if (!cancelled) setMembers(all.filter((m) => m.leftAt === null));
    });
    return () => {
      cancelled = true;
    };
  }, [open, roomId]);

  async function handleLeave() {
    if (!self || leaving) return;
    setLeaving(true);
    try {
      if (callRoomId === roomId) leaveCall();
      await roomService.leaveRoom(self, roomId);
      await loadRooms();
      onLeft();
      onClose();
    } finally {
      setLeaving(false);
    }
  }

  function displayNameFor(member: RoomMemberWire): string {
    if (member.id === self?.identityId) return self.displayName;
    return contactsById[member.id]?.displayName ?? member.displayName ?? "Unknown";
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Room members"
      size="sm"
      footer={
        <Button variant="danger" loading={leaving} onClick={() => void handleLeave()}>
          Leave room
        </Button>
      }
    >
      <ul className="flex flex-col gap-1">
        {members.map((member) => {
          const isSelf = member.id === self?.identityId;
          const inRoster = !!contactsById[member.id];
          const name = displayNameFor(member);

          return (
            <li
              key={member.id}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg-tertiary"
            >
              <Avatar
                id={member.id}
                name={name}
                size="sm"
                presence={presenceById[member.id]}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                {name}
                {isSelf && (
                  <span className="ml-1 text-xs text-text-muted">(you)</span>
                )}
              </span>
              {!isSelf && !inRoster && (
                <IconButton
                  icon={UserPlus}
                  label="Add friend"
                  size="sm"
                  onClick={() => {
                    if (self) {
                      friendRequestService.sendFriendRequest(self, member.id).catch((err) => {
                        console.error("Failed to send friend request:", err);
                      });
                    }
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
