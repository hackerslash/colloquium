import { useState } from "react";
import { Check } from "lucide-react";
import { useRosterStore } from "../../stores/useRosterStore";
import { useRoomStore } from "../../stores/useRoomStore";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { createGroupRoom } from "../../services/room/roomService";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Avatar } from "../ui/Avatar";
import { cx } from "../../lib/cx";

type CreateGroupModalProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (roomId: string) => void;
};

export function CreateGroupModal({ open, onClose, onCreated }: CreateGroupModalProps) {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const loadRooms = useRoomStore((s) => s.loadRooms);
  const contacts = Object.values(contactsById).filter((c) => !c.revoked);

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate() {
    if (!self || !name.trim() || selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      const roomId = await createGroupRoom(self, name.trim(), Array.from(selected));
      await loadRooms();
      onCreated(roomId);
      setName("");
      setSelected(new Set());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a room"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            loading={submitting}
            disabled={!name.trim() || selected.size === 0}
          >
            Create
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Room name"
        maxLength={48}
        className="w-full rounded-md border border-border-strong bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent"
      />
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Members
      </p>
      <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto">
        {contacts.map((contact) => {
          const isSelected = selected.has(contact.identityId);
          return (
            <li key={contact.identityId}>
              <button
                onClick={() => toggle(contact.identityId)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg-tertiary"
              >
                <Avatar id={contact.identityId} name={contact.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {contact.displayName}
                </span>
                <span
                  className={cx(
                    "flex h-5 w-5 items-center justify-center rounded-full border",
                    isSelected ? "border-accent bg-accent text-white" : "border-border-strong",
                  )}
                >
                  {isSelected && <Check size={12} aria-hidden="true" />}
                </span>
              </button>
            </li>
          );
        })}
        {contacts.length === 0 && (
          <li className="px-2 py-1 text-sm text-text-secondary">Invite some contacts first.</li>
        )}
      </ul>
    </Modal>
  );
}
