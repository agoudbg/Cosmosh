/**
 * Centralized Settings Store — single reactive source for all settings consumers.
 *
 * Built on React 18's `useSyncExternalStore` so every component sees the
 * same snapshot without redundant API calls or manual CustomEvent wiring.
 *
 * Lifecycle:
 *   1. `initializeSettingsStore()` is called once at bootstrap
 *      (loads from backend, applies runtime side-effects).
 *   2. Components read values via `useSettingsValue(key)` or `useSettingsValues()`.
 *   3. Settings.tsx updates values via `updateSettingsStoreValues(values)`.
 */

import type { SettingsValues } from '@cosmosh/api-contract';
import { DEFAULT_SETTINGS_VALUES } from '@cosmosh/api-contract';
import React from 'react';

import { applyRuntimeSettings } from './app-settings';
import { getAppSettings } from './backend';

// ── Internal State ───────────────────────────────────────────

type SettingsSnapshot = Readonly<SettingsValues>;

let currentSnapshot: SettingsSnapshot = { ...DEFAULT_SETTINGS_VALUES };
let storeInitialized = false;

// Listeners subscribed via `useSyncExternalStore`.
const listeners = new Set<() => void>();

const emitChange = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): SettingsSnapshot => {
  return currentSnapshot;
};

// ── Public API ───────────────────────────────────────────────

/**
 * Load settings from backend and apply runtime side-effects.
 * Intended to be called once during app bootstrap.
 */
export const initializeSettingsStore = async (): Promise<void> => {
  try {
    const response = await getAppSettings();
    currentSnapshot = Object.freeze({ ...response.data.item.values });
  } catch {
    currentSnapshot = Object.freeze({ ...DEFAULT_SETTINGS_VALUES });
  }

  storeInitialized = true;
  await applyRuntimeSettings(currentSnapshot);
  emitChange();
};

/**
 * Replace the entire settings snapshot.
 * Called after a successful settings save to propagate changes to all consumers.
 */
export const updateSettingsStoreValues = async (values: SettingsValues): Promise<void> => {
  currentSnapshot = Object.freeze({ ...values });
  await applyRuntimeSettings(currentSnapshot);
  emitChange();
};

/**
 * Check whether the store has been initialized.
 */
export const isSettingsStoreReady = (): boolean => {
  return storeInitialized;
};

// ── React Hooks ──────────────────────────────────────────────

/**
 * Subscribe to the entire settings snapshot.
 * Re-renders whenever any setting changes.
 */
export const useSettingsValues = (): SettingsSnapshot => {
  return React.useSyncExternalStore(subscribe, getSnapshot);
};

/**
 * Subscribe to a single setting value.
 * Re-renders only when that specific key's value changes.
 */
export function useSettingsValue<K extends keyof SettingsValues>(key: K): SettingsValues[K] {
  const selector = React.useCallback((snapshot: SettingsSnapshot) => snapshot[key], [key]);

  return React.useSyncExternalStore(subscribe, () => selector(getSnapshot()));
}
