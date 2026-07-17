import { useState } from "react";
import { Check, Copy, KeyRound, Shield, UserPlus } from "lucide-react";
import { useRosterStore } from "../../stores/useRosterStore";
import { Button } from "../ui/Button";
import { toast } from "../../stores/useToastStore";

export function HomeView() {
  const createInvite = useRosterStore((s) => s.createInvite);
  const acceptInvite = useRosterStore((s) => s.acceptInvite);

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [joinInput, setJoinInput] = useState("");
  const [joinStatus, setJoinStatus] = useState<"idle" | "joining" | "error" | "joined">("idle");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreateInvite() {
    setCreating(true);
    try {
      const link = await createInvite();
      setInviteLink(link);
      setCopied(false);
    } catch (err) {
      toast.error("Couldn't create invite", String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
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
      toast.success("Connected", "You're now trusted with that member.");
    } catch (err) {
      setJoinStatus("error");
      setJoinError(String(err));
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg p-8">
      <div className="mb-6 flex flex-col items-center text-center">
        <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
          <Shield size={28} aria-hidden="true" />
        </span>
        <h1 className="text-xl font-semibold text-text-primary">Welcome to Haven</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Connect with people you trust — no servers, no accounts.
        </p>
      </div>

      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-accent" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Invite someone</h2>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Share this with someone once — they'll be permanently trusted after.
          </p>
          <Button onClick={handleCreateInvite} loading={creating} className="mt-3">
            Create invite
          </Button>
          {inviteLink && (
            <div className="mt-3">
              <div className="relative">
                <p className="max-h-28 select-text overflow-y-auto break-all rounded-md border border-border bg-bg-base p-3 pr-10 font-mono text-xs text-text-secondary">
                  {inviteLink}
                </p>
                <button
                  onClick={handleCopy}
                  aria-label="Copy invite"
                  className="absolute right-2 top-2 rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleJoin} className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-accent" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Join with an invite</h2>
          </div>
          <textarea
            value={joinInput}
            onChange={(e) => setJoinInput(e.target.value)}
            rows={3}
            placeholder="Paste an invite here…"
            className="mt-2 w-full resize-none rounded-md border border-border-strong bg-bg-tertiary p-2 font-mono text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <Button
            type="submit"
            loading={joinStatus === "joining"}
            disabled={!joinInput.trim()}
            className="mt-2"
          >
            Connect
          </Button>
          {joinStatus === "error" && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {joinError}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
