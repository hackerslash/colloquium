import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, Shield } from "lucide-react";
import { motion } from "motion/react";
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
      <div className="flex h-full flex-col items-center justify-center bg-bg-base">
        <motion.div 
          animate={{ scale: [1, 1.05, 1], opacity: [0.8, 1, 0.8] }}
          transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
          className="flex h-16 w-16 items-center justify-center rounded-[1.25rem] bg-accent/10 text-accent ring-1 ring-accent/20"
        >
          <Shield size={32} strokeWidth={1.5} aria-hidden="true" />
        </motion.div>
      </div>
    );
  }

  if (bootStatus === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg-base p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/10 text-danger ring-1 ring-danger/20 mb-6">
          <AlertTriangle size={28} strokeWidth={1.5} aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold text-text-primary">Couldn't start Colloquium</h2>
        <p className="mt-2 mb-6 max-w-sm text-[15px] leading-relaxed text-text-secondary" style={{ textWrap: "balance" }}>
          There was an issue initializing the secure enclave. Check the logs below.
        </p>
        <pre className="max-w-xl w-full overflow-x-auto rounded-lg border border-border bg-bg-secondary p-4 text-left font-mono text-xs leading-relaxed text-text-secondary shadow-sm">
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
