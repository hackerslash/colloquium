import { useEffect, useState } from "react";
import { Check, UserPlus } from "lucide-react";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import * as roomService from "../../services/room/roomService";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Avatar } from "../ui/Avatar";
import { cx } from "../../lib/cx";
import { toast } from "../../stores/useToastStore";

type AddMembersModalProps = {
  open: boolean;
  onClose: () => void;
  roomId: string;
  currentMemberIds: string[];
  onAdded?: () => void;
};

export function AddMembersModal({
  open,
  onClose,
  roomId,
  currentMemberIds,
  onAdded,
}: AddMembersModalProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const loadRooms = useRoomStore((s) => s.loadRooms);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setSearchQuery("");
    }
  }, [open]);

  const currentMemberSet = new Set(currentMemberIds);
  const availableContacts = Object.values(contactsById)
    .filter((c) => !c.revoked && !currentMemberSet.has(c.identityId))
    .filter((c) =>
      searchQuery.trim() === ""
        ? true
        : c.displayName.toLowerCase().includes(searchQuery.toLowerCase().trim()),
    );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAdd() {
    if (!self || selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      await roomService.addMembersToGroupRoom(self, roomId, Array.from(selected));
      await loadRooms();
      toast.success("Members added", `Added ${selected.size} member(s) to space`);
      onAdded?.();
      onClose();
    } catch (err) {
      console.error("Failed to add members:", err);
      toast.error("Failed to add members", "Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add members to space"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleAdd()}
            loading={submitting}
            disabled={selected.size === 0}
            icon={UserPlus}
          >
            Add {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </>
      }
    >
      {Object.values(contactsById).filter((c) => !c.revoked && !currentMemberSet.has(c.identityId)).length > 5 && (
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search connections..."
          className="mb-3 w-full rounded-md border border-border-strong bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent"
        />
      )}
      <ul className="max-h-60 space-y-1 overflow-y-auto">
        {availableContacts.map((contact) => {
          const isSelected = selected.has(contact.identityId);
          return (
            <li key={contact.identityId}>
              <button
                type="button"
                onClick={() => toggle(contact.identityId)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg-tertiary"
              >
                <Avatar id={contact.identityId} name={contact.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {contact.displayName}
                </span>
                <span
                  className={cx(
                    "flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
                    isSelected ? "border-accent bg-accent text-white" : "border-border-strong",
                  )}
                >
                  {isSelected && <Check size={12} aria-hidden="true" />}
                </span>
              </button>
            </li>
          );
        })}
        {availableContacts.length === 0 && (
          <li className="px-2 py-3 text-center text-sm text-text-muted">
            {searchQuery
              ? "No matching connections found."
              : "All your connections are already in this space."}
          </li>
        )}
      </ul>
    </Modal>
  );
}
