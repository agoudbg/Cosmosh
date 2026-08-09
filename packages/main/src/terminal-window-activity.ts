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
  /** Plays the operating-system Bell signal. */
  beep: () => void;
  /** Reads Main-process monotonic time for effect throttling. */
  monotonicNow: () => number;
};

type AppliedProgress = Pick<TerminalWindowActivity, 'progressState' | 'progressValue'>;

/**
 * Applies validated renderer activity snapshots to one owning BrowserWindow.
 *
 * The controller de-duplicates OS calls and tracks a renderer epoch/sequence
 * high-water mark. An older Bell exposed after a newer tab closes therefore
 * cannot replay attention, while a renderer reload starts a distinct epoch.
 */
export class TerminalWindowActivityController {
  private appliedProgress: AppliedProgress | null = null;
  private latestBellRendererEpoch: string | null = null;
  private latestBellSequence = 0;
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
    if (!event) {
      return;
    }

    if (event.rendererEpoch !== this.latestBellRendererEpoch) {
      this.latestBellRendererEpoch = event.rendererEpoch;
      this.latestBellSequence = 0;
    }

    if (event.sequence <= this.latestBellSequence) {
      return;
    }

    this.latestBellSequence = event.sequence;
    const effectTime = this.effects.monotonicNow();
    if (activity.bellAudibleEnabled && effectTime - this.lastAudibleBellAt >= TERMINAL_BELL_EFFECT_THROTTLE_MS) {
      this.lastAudibleBellAt = effectTime;
      this.effects.beep();
    }

    if (
      activity.bellFlashEnabled &&
      !this.targetWindow.isFocused() &&
      effectTime - this.lastFlashBellAt >= TERMINAL_BELL_EFFECT_THROTTLE_MS
    ) {
      this.lastFlashBellAt = effectTime;
      this.targetWindow.flashFrame(true);
    }
  }
}
