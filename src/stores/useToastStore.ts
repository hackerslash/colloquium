import { create } from "zustand";

export type ToastVariant = "info" | "success" | "error" | "warning";

export type Toast = {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  /** Absent = ordinary toast, auto-dismisses. `null` = busy, indeterminate bar.
   * `0`–`100` = busy, determinate bar. Busy toasts never auto-dismiss; the
   * caller flips `progress` back to `undefined` when the work settles. */
  progress?: number | null;
};

type ToastState = {
  toasts: Toast[];
  add: (toast: Omit<Toast, "id"> & { id?: string }) => string;
  update: (id: string, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: string) => void;
};

const MAX_TOASTS = 5;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (toast) => {
    const id = toast.id ?? crypto.randomUUID();
    set((s) => {
      const next = [...s.toasts.filter((t) => t.id !== id), { ...toast, id }];
      return { toasts: next.slice(-MAX_TOASTS) };
    });
    return id;
  },
  // Patch in place (keeps list position), no-op if the toast was dismissed.
  update: (id, patch) =>
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Module-level helpers so services/components can fire toasts without hooks. */
export const toast = {
  info: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: "info", title, description }),
  success: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: "success", title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: "error", title, description }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: "warning", title, description }),
  /** Sticky toast with a progress bar. Returns its id; drive it with
   * `toast.setProgress` and end it with `toast.settle`. */
  busy: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: "info", title, description, progress: null }),
  setProgress: (id: string, pct: number | null) =>
    useToastStore.getState().update(id, { progress: pct }),
  /** Ends a busy toast: clears the bar so it auto-dismisses again. */
  settle: (id: string, variant: ToastVariant, title: string, description?: string) =>
    useToastStore.getState().update(id, { variant, title, description, progress: undefined }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
