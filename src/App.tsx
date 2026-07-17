import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, Loader2, Shield } from "lucide-react";
import { useIdentityStore } from "./stores/useIdentityStore";
import { useSettingsStore } from "./stores/useSettingsStore";
import { WelcomeScreen } from "./components/onboarding/WelcomeScreen";
import { MainShell } from "./components/layout/MainShell";
import { Toaster } from "./components/ui/Toaster";
import { startCallToastBridge } from "./services/call/callToastBridge";

function App() {
  const bootStatus = useIdentityStore((s) => s.bootStatus);
  const bootError = useIdentityStore((s) => s.bootError);
  const loadIdentity = useIdentityStore((s) => s.loadIdentity);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    const stopBridge = startCallToastBridge();
    // Load persisted settings (theme etc.) alongside identity so first paint
    // is correct, then reveal the window (it starts hidden to avoid a flash).
    void loadSettings();
    void loadIdentity().finally(() => {
      void getCurrentWindow()
        .show()
        .catch(() => {});
    });
    return stopBridge;
  }, [loadIdentity, loadSettings]);

  return (
    <>
      <Toaster />
      <AppBody bootStatus={bootStatus} bootError={bootError} />
    </>
  );
}

function AppBody({
  bootStatus,
  bootError,
}: {
  bootStatus: ReturnType<typeof useIdentityStore.getState>["bootStatus"];
  bootError: string | null;
}) {
  if (bootStatus === "idle" || bootStatus === "loading") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg-base">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
          <Shield size={28} aria-hidden="true" />
        </span>
        <Loader2
          size={18}
          className="animate-spin text-text-muted motion-reduce:animate-none"
          role="status"
          aria-label="Loading Haven"
        />
        <p className="text-xs text-text-muted">Starting Haven…</p>
      </div>
    );
  }

  if (bootStatus === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg-base p-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
          <AlertTriangle size={22} aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-text-primary">Couldn't start Haven</p>
        <pre className="max-w-md whitespace-pre-wrap rounded-md bg-bg-tertiary p-3 text-left font-mono text-xs text-text-secondary">
          {bootError}
        </pre>
      </div>
    );
  }

  if (bootStatus === "needs-onboarding") {
    return <WelcomeScreen />;
  }

  return <MainShell />;
}

export default App;
