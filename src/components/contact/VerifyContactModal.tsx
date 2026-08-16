import { useEffect, useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import * as rosterRepo from "../../services/db/rosterRepo";
import { safetyNumber } from "../../lib/crypto";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { toast } from "../../stores/useToastStore";
import { copyText } from "../../lib/clipboard";

type VerifyContactModalProps = {
  open: boolean;
  onClose: () => void;
  contactId: string;
};

export function VerifyContactModal({ open, onClose, contactId }: VerifyContactModalProps) {
  const self = useIdentityStore((s) => s.self);
  const contact = useRosterStore((s) => s.contactsById[contactId]);
  const loadRoster = useRosterStore((s) => s.loadRoster);
  const [groups, setGroups] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !self || !contact) return;
    let live = true;
    void safetyNumber(self.publicKey, contact.publicKey).then((g) => {
      if (live) setGroups(g);
    });
    return () => {
      live = false;
    };
  }, [open, self, contact]);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const verified = contact?.verifiedAt != null;

  async function handleToggleVerified() {
    if (!contact) return;
    await rosterRepo.setVerified(contact.identityId, verified ? null : Date.now());
    await loadRoster();
    toast.success(
      verified ? "Verification cleared" : `${contact.displayName} verified`,
      verified ? undefined : "Their key is now marked as confirmed on this device.",
    );
  }

  async function handleCopy() {
    if (!groups) return;
    const ok = await copyText(groups.join(" "));
    if (ok) setCopied(true);
    else toast.error("Copy failed", "Couldn't copy to clipboard.");
  }

  if (!contact) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Verify ${contact.displayName}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button onClick={handleToggleVerified} variant={verified ? "secondary" : "primary"}>
            {verified ? "Clear verification" : "Mark as verified"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">
        Compare these numbers with {contact.displayName} over a voice call or in person. If they
        match, nobody swapped keys when you exchanged invites.
      </p>

      {groups ? (
        <div className="mt-4 grid grid-cols-3 gap-x-6 gap-y-2 rounded-md border border-border bg-bg-tertiary px-4 py-4 text-center font-mono text-base tracking-widest text-text-primary">
          {groups.map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </div>
      ) : (
        <div className="mt-4 h-[132px] rounded-md border border-border bg-bg-tertiary" />
      )}

      {verified && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-success">
          <ShieldCheck size={14} aria-hidden="true" />
          Verified on this device on {new Date(contact.verifiedAt!).toLocaleDateString()}.
        </p>
      )}
      <p className="mt-4 text-xs text-text-muted">
        Verification is stored only on this device and is never sent to peers.
      </p>
    </Modal>
  );
}
