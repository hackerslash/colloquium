import { useEffect, useState } from "react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { useRosterStore } from "../../stores/useRosterStore";
import { initNetworkBridge } from "../../services/bridge/networkBridge";
import type { Presence } from "../../types/domain";

let bridgeStarted = false;

const PRESENCE_LABEL: Record<Presence, string> = {
  online: "Online",
  connecting: "Connecting…",
  offline: "Offline",
};

const PRESENCE_DOT: Record<Presence, string> = {
  online: "bg-success",
  connecting: "bg-warning",
  offline: "bg-text-secondary",
};

function shortId(identityId: string): string {
  return `${identityId.slice(0, 8)}…${identityId.slice(-4)}`;
}

export function MainShell() {
  const self = useIdentityStore((s) => s.self);
  const contactsById = useRosterStore((s) => s.contactsById);
  const presenceById = useRosterStore((s) => s.presenceById);
  const loadRoster = useRosterStore((s) => s.loadRoster);
  const createInvite = useRosterStore((s) => s.createInvite);
  const acceptInvite = useRosterStore((s) => s.acceptInvite);

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [joinInput, setJoinInput] = useState("");
  const [joinStatus, setJoinStatus] = useState<"idle" | "joining" | "error" | "joined">("idle");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!self || bridgeStarted) return;
    bridgeStarted = true;
    initNetworkBridge(self);
  }, [self]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  async function handleCreateInvite() {
    setInviteError(null);
    try {
      const link = await createInvite();
      setInviteLink(link);
      setCopied(false);
    } catch (err) {
      setInviteError(String(err));
    }
  }

  async function handleCopy() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!joinInput.trim() || joinStatus === "joining") return;
    setJoinStatus("joining");
    setJoinError(null);
    try {
      await acceptInvite(joinInput.trim());
      setJoinStatus("joined");
      setJoinInput("");
    } catch (err) {
      setJoinStatus("error");
      setJoinError(String(err));
    }
  }

  const contacts = Object.values(contactsById).filter((c) => !c.revoked);

  return (
    <div className="flex h-full flex-col bg-bg-primary text-text-primary">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <p className="font-semibold">{self?.displayName}</p>
          <p className="font-mono text-xs text-text-secondary">
            {self ? shortId(self.identityId) : null}
          </p>
        </div>
      </header>

      <main className="flex flex-1 gap-6 overflow-auto p-6">
        <section className="flex-1 space-y-4">
          <div className="rounded-xl bg-bg-secondary p-4">
            <h2 className="text-sm font-semibold">Invite someone</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Share this with someone once — they'll be permanently trusted after.
            </p>
            <button
              onClick={handleCreateInvite}
              className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Create invite
            </button>
            {inviteError && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {inviteError}
              </p>
            )}
            {inviteLink && (
              <div className="mt-3">
                <textarea
                  readOnly
                  value={inviteLink}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-border bg-bg-tertiary p-2 font-mono text-xs text-text-primary"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={handleCopy}
                  className="mt-2 rounded-lg border border-border px-3 py-1 text-xs font-medium hover:bg-bg-tertiary"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
          </div>

          <form onSubmit={handleJoin} className="rounded-xl bg-bg-secondary p-4">
            <h2 className="text-sm font-semibold">Join with an invite</h2>
            <textarea
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              rows={3}
              placeholder="Paste an invite here…"
              className="mt-2 w-full resize-none rounded-lg border border-border bg-bg-tertiary p-2 font-mono text-xs text-text-primary outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={!joinInput.trim() || joinStatus === "joining"}
              className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {joinStatus === "joining" ? "Connecting…" : "Connect"}
            </button>
            {joinStatus === "error" && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {joinError}
              </p>
            )}
            {joinStatus === "joined" && (
              <p role="status" className="mt-2 text-sm text-success">
                You're now trusted with that member.
              </p>
            )}
          </form>
        </section>

        <aside className="w-64 shrink-0">
          <h2 className="text-sm font-semibold text-text-secondary">
            Contacts — {contacts.length}
          </h2>
          <ul className="mt-2 space-y-1">
            {contacts.map((contact) => {
              const presence = presenceById[contact.identityId] ?? "offline";
              return (
                <li
                  key={contact.identityId}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-secondary"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[presence]}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm">{contact.displayName}</p>
                    <p className="text-xs text-text-secondary">
                      {PRESENCE_LABEL[presence]}
                    </p>
                  </div>
                </li>
              );
            })}
            {contacts.length === 0 && (
              <li className="text-sm text-text-secondary">No contacts yet.</li>
            )}
          </ul>
        </aside>
      </main>
    </div>
  );
}
