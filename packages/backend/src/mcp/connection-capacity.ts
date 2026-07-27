/**
 * Shared capacity accounting for background SSH clients, pending terminal
 * launches, and terminal attachments.
 *
 * A reservation remains owned by exactly one pending or active resource until
 * that resource fails or closes. Keeping this counter outside individual
 * registries prevents cross-mode races from exceeding the global limit.
 */

import { MCP_MAX_CONNECTIONS } from './constants.js';

/**
 * Idempotent handle for one reserved MCP connection slot.
 */
export type McpConnectionCapacityReservation = {
  /** Releases the slot when its pending or active owner is finished. */
  release(): void;
};

/**
 * Coordinates the global MCP connection limit across all connection modes.
 */
export class McpConnectionCapacity {
  private readonly limit: number;

  private used = 0;

  /**
   * Creates a capacity coordinator.
   *
   * @param limit Maximum simultaneous reservations.
   */
  public constructor(limit = MCP_MAX_CONNECTIONS) {
    this.limit = limit;
  }

  /**
   * Attempts to reserve one connection slot atomically.
   *
   * @returns An idempotent reservation, or null when the limit is exhausted.
   */
  public tryReserve(): McpConnectionCapacityReservation | null {
    if (this.used >= this.limit) {
      return null;
    }

    this.used += 1;
    let released = false;

    return {
      release: (): void => {
        if (released) {
          return;
        }

        released = true;
        this.used = Math.max(0, this.used - 1);
      },
    };
  }

  /**
   * Returns the number of pending and active reservations.
   *
   * @returns Current reserved slot count.
   */
  public count(): number {
    return this.used;
  }

  /**
   * Returns the configured hard limit.
   *
   * @returns Maximum reservation count.
   */
  public getLimit(): number {
    return this.limit;
  }
}
