import { parseTerminalWindowActivity, type TerminalWindowActivity } from '@cosmosh/api-contract';
import type { BrowserWindow } from 'electron';

/** Minimal BrowserWindow surface required by terminal presentation integration. */
export type TerminalWindowActivityTarget = Pick<
  BrowserWindow,
  'flashFrame' | 'isDestroyed' | 'isFocused' | 'setProgressBar'
>;

/** Minimum interval between repeated Bell effects of the same kind. */
export const TERMINAL_BELL_EFFECT_THROTTLE_MS = 1_000;

/** Privileged Bell side effects supplied by the Electron integration boundary. */
export type TerminalWindowActivityEffects = {
  beep: () => void;
};

type AppliedProgress = Pick<TerminalWindowActivity, 'progressState' | 'progressValue'>;

/**
 * Applies validated renderer activity snapshots to one owning BrowserWindow.
 *
 * The controller de-duplicates OS calls and tracks a Bell receipt-time high
 * water mark. An older Bell exposed after a newer tab closes therefore cannot
 * replay attention, while distinct Bells received in the same clock tick
 * retain their renderer-window event identities.
 */
export class TerminalWindowActivityController {
  private appliedProgress: AppliedProgress | null = null;
  private latestBellReceivedAt = -1;
  private readonly latestBellKeys = new Set<string>();
  private lastAudibleBellAt = Number.NEGATIVE_INFINITY;
  private lastFlashBellAt = Number.NEGATIVE_INFINITY;

  /**
   * Creates a controller bound to one BrowserWindow.
   *
   * @param targetWindow Window that owns the renderer sending activity.
   * @param effects Privileged operating-system effects for Bell attention.
   */
  constructor(
    private readonly targetWindow: TerminalWindowActivityTarget,
    private readonly effects: TerminalWindowActivityEffects,
  ) {}

  /**
   * Validates and applies one renderer-provided activity snapshot.
   *
   * @param value Untrusted IPC payload.
   * @returns Whether a valid snapshot was accepted.
   */
  apply(value: unknown): boolean {
    if (this.targetWindow.isDestroyed()) {
      return false;
    }

    const activity = parseTerminalWindowActivity(value);
    if (!activity) {
      return false;
    }

    this.applyProgress(activity);
    this.applyBellEvent(activity);
    return true;
  }

  /**
   * Stops an outstanding frame flash when the owning window receives focus.
   *
   * @returns Nothing.
   */
  acknowledgeWindowFocus(): void {
    if (!this.targetWindow.isDestroyed()) {
      this.targetWindow.flashFrame(false);
    }
  }

  /**
   * Applies changed taskbar progress using Electron's platform mapping.
   *
   * @param activity Validated window activity snapshot.
   * @returns Nothing.
   */
  private applyProgress(activity: TerminalWindowActivity): void {
    if (
      this.appliedProgress?.progressState === activity.progressState &&
      this.appliedProgress.progressValue === activity.progressValue
    ) {
      return;
    }

    this.appliedProgress = {
      progressState: activity.progressState,
      progressValue: activity.progressValue,
    };

    if (activity.progressState === 'none') {
      this.targetWindow.setProgressBar(-1);
      return;
    }

    if (activity.progressState === 'indeterminate') {
      this.targetWindow.setProgressBar(2, { mode: 'indeterminate' });
      return;
    }

    const progress = (activity.progressValue ?? 0) / 100;
    const mode =
      activity.progressState === 'error' ? 'error' : activity.progressState === 'warning' ? 'paused' : 'normal';
    this.targetWindow.setProgressBar(progress, { mode });
  }

  /**
   * Applies independently throttled sound and Flash effects for a new Bell edge.
   *
   * Every new edge advances the replay guard even when its configured effect is
   * disabled or throttled. Changing settings therefore cannot replay an older
   * Bell that was already observed by Main.
   *
   * @param activity Validated window activity snapshot.
   * @returns Nothing.
   */
  private applyBellEvent(activity: TerminalWindowActivity): void {
    const event = activity.latestBellEvent;
    if (!event || event.receivedAt < this.latestBellReceivedAt) {
      return;
    }

    if (event.receivedAt > this.latestBellReceivedAt) {
      this.latestBellReceivedAt = event.receivedAt;
      this.latestBellKeys.clear();
    }

    const eventKey = `${event.tabId}\u001f${event.paneId}\u001f${event.sequence}`;
    if (this.latestBellKeys.has(eventKey)) {
      return;
    }

    this.latestBellKeys.add(eventKey);
    if (activity.bellAudibleEnabled && event.receivedAt - this.lastAudibleBellAt >= TERMINAL_BELL_EFFECT_THROTTLE_MS) {
      this.lastAudibleBellAt = event.receivedAt;
      this.effects.beep();
    }

    if (
      activity.bellFlashEnabled &&
      !this.targetWindow.isFocused() &&
      event.receivedAt - this.lastFlashBellAt >= TERMINAL_BELL_EFFECT_THROTTLE_MS
    ) {
      this.lastFlashBellAt = event.receivedAt;
      this.targetWindow.flashFrame(true);
    }
  }
}
