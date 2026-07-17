import { useState } from "react";
import { motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { Button } from "../ui/Button";

/** The raw error is a Rust/keyring failure string — not something a
 * first-time user can act on. Map the cases we know about to plain
 * language; the raw text is still logged to the console for debugging. */
function friendlyIdentityError(err: unknown): string {
  const raw = String(err);
  if (raw.includes("already exists")) {
    return "This device already has an identity. Restart Haven to continue with it.";
  }
  if (/keychain|keyring/i.test(raw)) {
    return "Haven couldn't reach your system's secure storage. Check your OS security settings and try again.";
  }
  return "Something went wrong setting up your identity. Please try again.";
}

export function WelcomeScreen() {
  const createIdentity = useIdentityStore((s) => s.createIdentity);
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await createIdentity(trimmed);
    } catch (err) {
      console.error("Failed to create identity:", err);
      setError(friendlyIdentityError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg-base p-6">
      <div className="w-full max-w-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="rounded-[24px] border border-border/50 bg-bg-primary p-10 shadow-soft"
        >
          <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-[18px] bg-bg-secondary text-accent">
            <Sparkles size={24} strokeWidth={1.5} aria-hidden="true" />
          </div>
          
          <h1 className="font-display italic text-[28px] font-normal tracking-[-0.02em] text-text-primary mb-3" style={{ textWrap: "balance" }}>
            A space to connect.
          </h1>
          <p className="text-[15px] leading-relaxed text-text-secondary">
            Haven keeps your conversations private and local. Pick a name to start building your enclave.
          </p>

          <form onSubmit={handleSubmit} className="mt-8">
            <div className="space-y-2">
              <input
                id="displayName"
                autoFocus
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="What should we call you?"
                maxLength={32}
                className="w-full rounded-[16px] border border-border bg-bg-secondary px-4 py-3.5 text-[15px] text-text-primary outline-none transition-all placeholder:text-text-muted focus:border-accent focus:bg-bg-primary focus:ring-1 focus:ring-accent"
              />
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                role="alert"
                className="mt-3 text-sm font-medium text-danger"
              >
                {error}
              </motion.p>
            )}

            <Button
              type="submit"
              size="lg"
              loading={submitting}
              disabled={!displayName.trim()}
              className="mt-8 w-full shadow-soft"
            >
              Enter Haven
            </Button>
          </form>
        </motion.div>
        
        <motion.p 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.8 }}
          className="mt-8 text-center text-[13px] text-text-muted"
        >
          Secured on your device, always.
        </motion.p>
      </div>
    </div>
  );
}
