import { useEffect } from "react";
import { useIdentityStore } from "./stores/useIdentityStore";
import { WelcomeScreen } from "./components/onboarding/WelcomeScreen";
import { MainShell } from "./components/layout/MainShell";

function App() {
  const bootStatus = useIdentityStore((s) => s.bootStatus);
  const bootError = useIdentityStore((s) => s.bootError);
  const loadIdentity = useIdentityStore((s) => s.loadIdentity);

  useEffect(() => {
    loadIdentity();
  }, [loadIdentity]);

  if (bootStatus === "idle" || bootStatus === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-bg-primary">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent"
          role="status"
          aria-label="Loading Haven"
        />
      </div>
    );
  }

  if (bootStatus === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-bg-primary">
        <p className="max-w-sm text-center text-sm text-danger">
          Couldn't start Haven: {bootError}
        </p>
      </div>
    );
  }

  if (bootStatus === "needs-onboarding") {
    return <WelcomeScreen />;
  }

  return <MainShell />;
}

export default App;
