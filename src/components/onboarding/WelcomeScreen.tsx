import { useState } from "react";
import { motion } from "motion/react";
import { Shield } from "lucide-react";
import { useIdentityStore } from "../../stores/useIdentityStore";
import { Button } from "../ui/Button";

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
      setError(String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg-base p-6">
      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
        className="w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-8 shadow-modal"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
          <Shield size={28} aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-text-primary">
          Welcome to Haven
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Create your identity to get started. This device generates a private key that never
          leaves your machine — it's how trusted members recognize you.
        </p>

        <label
          htmlFor="displayName"
          className="mt-6 block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Display name
        </label>
        <input
          id="displayName"
          autoFocus
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Afridi"
          maxLength={32}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent"
        />

        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          disabled={!displayName.trim()}
          className="mt-6 w-full"
        >
          Get started
        </Button>
      </motion.form>
    </div>
  );
}
