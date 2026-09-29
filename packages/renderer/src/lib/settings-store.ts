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
import { DEFAULT_SETTINGS_VALUES, normalizeSettingsValuesWithDefaults } from '@cosmosh/api-contract';
import React from 'react';

import { applyRuntimeSettings } from './app-settings';
import { getAppSettings } from './backend';

// ── Internal State ───────────────────────────────────────────

type SettingsSnapshot = Readonly<SettingsValues>;

let currentSnapshot: SettingsSnapshot = { ...DEFAULT_SETTINGS_VALUES };
let storeInitialized = false;
let settingsRefreshPromise: Promise<void> | null = null;

const SETTINGS_CACHE_STORAGE_KEY = 'cosmosh.renderer.settings-cache.v1';

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

/**
 * Persists the latest settings snapshot for fast next-launch hydration.
 *
 * @param values Latest settings values.
 * @returns Nothing.
 */
const persistSettingsCache = (values: SettingsValues): void => {
  try {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(SETTINGS_CACHE_STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Ignore cache persistence failures and keep runtime in-memory state only.
  }
};

/**
 * Reads cached settings snapshot from localStorage.
 *
 * @returns Cached values or `null` when unavailable/invalid.
 */
const readCachedSettings = (): SettingsValues | null => {
  try {
    if (typeof window === 'undefined') {
      return null;
    }

    const rawPayload = window.localStorage.getItem(SETTINGS_CACHE_STORAGE_KEY);
    if (!rawPayload) {
      return null;
    }

    const parsed: unknown = JSON.parse(rawPayload);
    return normalizeSettingsValuesWithDefaults(parsed);
  } catch {
    return null;
  }
};

/**
 * Fetches canonical settings from backend and applies them to the shared store.
 *
 * @returns Nothing.
 */
const refreshSettingsFromBackend = async (): Promise<void> => {
  const response = await getAppSettings();
  const nextValues = Object.freeze({ ...response.data.item.values });
  currentSnapshot = nextValues;
  persistSettingsCache(nextValues);
  await applyRuntimeSettings(nextValues);
  emitChange();
};

// ── Public API ───────────────────────────────────────────────

/**
 * Load settings from backend and apply runtime side-effects.
 * Intended to be called once during app bootstrap.
 */
export const initializeSettingsStore = async (): Promise<void> => {
  if (storeInitialized) {
    return;
  }

  const cachedValues = readCachedSettings();
  const initialValues = cachedValues ?? { ...DEFAULT_SETTINGS_VALUES };
  currentSnapshot = Object.freeze(initialValues);
  persistSettingsCache(initialValues);

  storeInitialized = true;
  await applyRuntimeSettings(currentSnapshot);
  emitChange();

  if (!settingsRefreshPromise) {
    settingsRefreshPromise = refreshSettingsFromBackend()
      .catch(() => {
        // Keep cached/default snapshot when backend is unavailable during startup.
      })
      .finally(() => {
        settingsRefreshPromise = null;
      });
  }
};

/**
 * Replace the entire settings snapshot.
 * Called after a successful settings save to propagate changes to all consumers.
 */
export const updateSettingsStoreValues = async (values: SettingsValues): Promise<void> => {
  currentSnapshot = Object.freeze({ ...values });
  persistSettingsCache(values);
  await applyRuntimeSettings(currentSnapshot);
  emitChange();
};

/**
 * Check whether the store has been initialized.
 */
export const isSettingsStoreReady = (): boolean => {
  return storeInitialized;
};

/**
 * Returns the current immutable settings snapshot for non-React connection helpers.
 *
 * @returns Current settings values.
 */
export const getSettingsValuesSnapshot = (): SettingsSnapshot => {
  return currentSnapshot;
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
