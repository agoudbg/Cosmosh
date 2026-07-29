import { parseTerminalWindowActivity, type TerminalWindowActivity } from '@cosmosh/api-contract';
import type { BrowserWindow } from 'electron';

/** Minimal BrowserWindow surface required by terminal presentation integration. */
export type TerminalWindowActivityTarget = Pick<
  BrowserWindow,
  'flashFrame' | 'isDestroyed' | 'isFocused' | 'setProgressBar'
>;

type AppliedProgress = Pick<TerminalWindowActivity, 'progressState' | 'progressValue'>;

/**
 * Applies validated renderer activity snapshots to one owning BrowserWindow.
 *
 * The controller de-duplicates OS calls and tracks a Bell receipt-time high
 * water mark. An older Bell exposed after a newer tab closes therefore cannot
 * replay attention, while distinct Bells received in the same clock tick
 * retain their pane-local event identities.
 */
export class TerminalWindowActivityController {
  private appliedProgress: AppliedProgress | null = null;
  private latestBellReceivedAt = -1;
  private readonly latestBellKeys = new Set<string>();

  /**
   * Creates a controller bound to one BrowserWindow.
   *
   * @param targetWindow Window that owns the renderer sending activity.
   */
  constructor(private readonly targetWindow: TerminalWindowActivityTarget) {}

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
    this.applyBellEvent(activity.latestBellEvent);
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
   * Flashes only for a new standalone Bell edge while the window is unfocused.
   *
   * @param event Latest Bell identity from the renderer snapshot.
   * @returns Nothing.
   */
  private applyBellEvent(event: TerminalWindowActivity['latestBellEvent']): void {
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
    if (!this.targetWindow.isFocused()) {
      this.targetWindow.flashFrame(true);
    }
  }
}
