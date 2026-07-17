import { useState } from "react";
import { Check, Copy, KeyRound, UserPlus, Sparkles } from "lucide-react";
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
      console.error("Failed to accept invite:", err);
      setJoinStatus("error");
      setJoinError(String(err));
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-10 pt-16">
      <div className="mb-14 flex flex-col items-center text-center">
        <span className="mb-6 flex h-14 w-14 items-center justify-center rounded-[18px] bg-bg-secondary text-accent">
          <Sparkles size={24} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h1 className="font-display italic text-[32px] font-normal tracking-[-0.02em] text-text-primary" style={{ textWrap: "balance" }}>
          Welcome home.
        </h1>
        <p className="mt-3 max-w-sm text-[16px] leading-relaxed text-text-secondary" style={{ textWrap: "balance" }}>
          Connect with the people you trust. No servers in the middle, just you and them.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Create Invite Section */}
        <section className="flex flex-col rounded-[24px] border border-border/50 bg-bg-secondary p-8 shadow-sm transition-shadow hover:shadow-soft">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-bg-primary text-accent shadow-sm">
              <UserPlus size={18} aria-hidden="true" />
            </span>
            <h2 className="text-[16px] font-semibold tracking-tight text-text-primary">Bring someone in</h2>
          </div>
          <p className="mb-8 text-[14px] leading-relaxed text-text-secondary">
            Share an invite string once. When they connect, the trust is permanent.
          </p>
          <div className="mt-auto">
            {!inviteLink ? (
              <Button onClick={handleCreateInvite} loading={creating} className="w-full">
                Generate invite
              </Button>
            ) : (
              <div className="relative animate-in fade-in slide-in-from-bottom-2 duration-300">
                <p className="max-h-24 select-text overflow-y-auto break-all rounded-[16px] border border-border bg-bg-primary p-4 pr-12 font-mono text-[12px] leading-relaxed text-text-secondary">
                  {inviteLink}
                </p>
                <button
                  onClick={handleCopy}
                  aria-label="Copy invite"
                  className="absolute right-2 top-2 rounded-full p-2 text-text-muted transition-colors hover:bg-bg-secondary hover:text-text-primary"
                >
                  {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Join Invite Section */}
        <section className="flex flex-col rounded-[24px] border border-border/50 bg-bg-secondary p-8 shadow-sm transition-shadow hover:shadow-soft">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-bg-primary text-accent shadow-sm">
              <KeyRound size={18} aria-hidden="true" />
            </span>
            <h2 className="text-[16px] font-semibold tracking-tight text-text-primary">Accept an invite</h2>
          </div>
          <p className="mb-6 text-[14px] leading-relaxed text-text-secondary">
            Got an invite string? Paste it below to establish a secure connection.
          </p>
          <form onSubmit={handleJoin} className="mt-auto flex flex-col gap-4">
            <textarea
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              rows={2}
              placeholder="Paste invite string here..."
              className="w-full resize-none rounded-[16px] border border-border bg-bg-primary p-4 font-mono text-[12px] text-text-primary outline-none transition-all placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent"
            />
            <Button
              type="submit"
              loading={joinStatus === "joining"}
              disabled={!joinInput.trim()}
              className="w-full"
            >
              Connect
            </Button>
            {joinStatus === "error" && (
              <p role="alert" className="text-center text-[13px] font-medium text-danger animate-in fade-in">
                {joinError}
              </p>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}
