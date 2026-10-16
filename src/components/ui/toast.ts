import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}

interface ToastState {
  toasts: Toast[];
  show(message: string, tone?: Toast["tone"]): void;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show(message, tone = "info") {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-2), { id, message, tone }] });
    setTimeout(() => get().dismiss(id), tone === "error" ? 6000 : 3000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Shows a short confirmation above the player bar. */
export const toast = (message: string) => useToasts.getState().show(message);
export const toastError = (message: string) => useToasts.getState().show(message, "error");
