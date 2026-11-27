import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastTone = "default" | "success" | "danger";
export type ToastAction = { label: string; run: () => void | Promise<void> };
/** Why a toast's countdown is held: the pointer is over it, or keyboard focus is inside it. */
type ToastHold = "hover" | "focus";
/** @internal test-only */
export type Toast = { id: number; message: string; tone: ToastTone; action?: ToastAction };

const TIMEOUT_MS = 4_000;
const ACTION_TIMEOUT_MS = 8_000;
/** A resumed toast gets at least this long, so leaving it never dismisses it under the pointer. */
const MIN_RESUME_MS = 2_000;
/** The cap applies to each kind on its own, so a burst of plain toasts never evicts a pending undo. */
const MAX_TOASTS_PER_KIND = 4;

type Countdown = { handle: number; startedAt: number; remainingMs: number; holds: Set<ToastHold> };

export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  const countdowns = new Map<number, Countdown>();
  let nextId = 1;

  function startCountdown(id: number, remainingMs: number, holds: Set<ToastHold>): void {
    countdowns.set(id, {
      handle: window.setTimeout(() => dismissToast(id), remainingMs),
      startedAt: Date.now(),
      remainingMs,
      holds,
    });
  }

  function dismissToast(id: number): void {
    const countdown = countdowns.get(id);
    if (countdown) window.clearTimeout(countdown.handle);
    countdowns.delete(id);
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function showToast(message: string, tone: ToastTone = "default", action?: ToastAction): void {
    const id = nextId++;
    const sameKind = toasts.value.filter((toast) => Boolean(toast.action) === Boolean(action));
    const oldest = sameKind[0];
    if (oldest && sameKind.length >= MAX_TOASTS_PER_KIND) dismissToast(oldest.id);
    toasts.value = [...toasts.value, { id, message, tone, action }];
    startCountdown(id, action ? ACTION_TIMEOUT_MS : TIMEOUT_MS, new Set());
  }

  function holdToast(id: number, hold: ToastHold): void {
    const countdown = countdowns.get(id);
    if (!countdown) return;
    if (countdown.holds.size === 0) {
      window.clearTimeout(countdown.handle);
      countdown.remainingMs = Math.max(0, countdown.remainingMs - (Date.now() - countdown.startedAt));
    }
    countdown.holds.add(hold);
  }

  function releaseToast(id: number, hold: ToastHold): void {
    const countdown = countdowns.get(id);
    if (!countdown?.holds.delete(hold) || countdown.holds.size > 0) return;
    startCountdown(id, Math.max(countdown.remainingMs, MIN_RESUME_MS), countdown.holds);
  }

  async function runToastAction(id: number): Promise<void> {
    const action = toasts.value.find((toast) => toast.id === id)?.action;
    dismissToast(id);
    await action?.run();
  }

  function $reset(): void {
    for (const countdown of countdowns.values()) window.clearTimeout(countdown.handle);
    countdowns.clear();
    toasts.value = [];
  }

  return { toasts, showToast, dismissToast, holdToast, releaseToast, runToastAction, $reset };
});
