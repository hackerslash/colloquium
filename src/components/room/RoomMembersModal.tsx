import { useEffect, useState } from "react";
import { Check, Edit2, UserPlus, X } from "lucide-react";
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
import { AddMembersModal } from "./AddMembersModal";
import { toast } from "../../stores/useToastStore";

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
  const room = useRoomStore((s) => s.roomsById[roomId]);
  const loadRooms = useRoomStore((s) => s.loadRooms);
  const callRoomId = useRoomCallStore((s) => s.roomId);
  const leaveCall = useRoomCallStore((s) => s.leave);

  const [members, setMembers] = useState<RoomMemberWire[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);

  const fetchMembers = () => {
    void roomMembersRepo.listMembersFull(roomId).then((all) => {
      setMembers(all.filter((m) => m.leftAt === null));
    });
  };

  useEffect(() => {
    if (!open) {
      setIsEditingName(false);
      return;
    }
    fetchMembers();
  }, [open, roomId]);

  useEffect(() => {
    if (room?.name) setNewName(room.name);
  }, [room?.name]);

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

  function displayNameFor(member: RoomMemberWire): string {
    if (member.id === self?.identityId) return self.displayName;
    return contactsById[member.id]?.displayName ?? member.displayName ?? "Unknown";
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={room?.name ? `Space: ${room.name}` : "Space details"}
        size="md"
        footer={
          <div className="flex w-full items-center justify-between">
            <Button
              variant="secondary"
              size="sm"
              icon={UserPlus}
              onClick={() => setAddMembersOpen(true)}
            >
              Add members
            </Button>
            <Button variant="danger" size="sm" loading={leaving} onClick={() => void handleLeave()}>
              Leave space
            </Button>
          </div>
        }
      >
        {/* Rename section */}
        <div className="mb-4 rounded-xl border border-border bg-bg-secondary p-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Space name
          </div>
          {isEditingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleRename();
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={48}
                disabled={renaming}
                className="flex-1 rounded-md border border-border-strong bg-bg-tertiary px-2.5 py-1 text-sm text-text-primary outline-none focus:border-accent"
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
                  setNewName(room?.name ?? "");
                  setIsEditingName(false);
                }}
              />
            </form>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-text-primary">{room?.name ?? "Space"}</span>
              <IconButton
                icon={Edit2}
                label="Rename space"
                size="sm"
                onClick={() => setIsEditingName(true)}
              />
            </div>
          )}
        </div>

        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Members ({members.length})
        </div>
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
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
                  {member.role === "owner" && (
                    <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                      Owner
                    </span>
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

      <AddMembersModal
        open={addMembersOpen}
        onClose={() => setAddMembersOpen(false)}
        roomId={roomId}
        currentMemberIds={members.map((m) => m.id)}
        onAdded={fetchMembers}
      />
    </>
  );
}
