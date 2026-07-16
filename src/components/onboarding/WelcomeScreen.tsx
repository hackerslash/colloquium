import { useState } from "react";
import { useIdentityStore } from "../../stores/useIdentityStore";

export function WelcomeScreen() {
  const createIdentity = useIdentityStore((s) => s.createIdentity);
  const bootNotice = useIdentityStore((s) => s.bootNotice);
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
    <div className="flex h-full items-center justify-center bg-bg-primary">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl bg-bg-secondary p-8 shadow-xl"
      >
        <h1 className="text-2xl font-semibold text-text-primary">
          Welcome to Haven
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Create your identity to get started. This device will generate a
          private key that never leaves your machine — it's how other
          trusted members will recognize you.
        </p>

        {bootNotice && (
          <p
            role="status"
            className="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            {bootNotice}
          </p>
        )}

        <label
          htmlFor="displayName"
          className="mt-6 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
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
          className="mt-1.5 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-text-primary outline-none focus:ring-2 focus:ring-accent"
        />

        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!displayName.trim() || submitting}
          className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Creating identity…" : "Get Started"}
        </button>
      </form>
    </div>
  );
}
