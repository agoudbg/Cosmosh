/**
 * Renderer-side re-export of the shared settings registry.
 *
 * All setting definitions, types, defaults, and helpers now live in
 * @cosmosh/api-contract/settings-registry (the single source of truth).
 * This file exists solely to keep existing import paths stable.
 */

import { SETTINGS_REGISTRY as SHARED_SETTINGS_REGISTRY } from '@cosmosh/api-contract';

/** Compatibility-only prompt parsing remains readable for old timeline preferences, but cannot configure suggestions. */
export const VISIBLE_SETTINGS_REGISTRY = SHARED_SETTINGS_REGISTRY.filter(
  (setting) => setting.key !== 'terminalAutoCompletePromptRegex',
);

export {
  getVisibleCategories,
  paginateSettingsByCategory,
  resolveCategoryId,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_IDS,
  SETTINGS_DEFINITION_MAP,
  SETTINGS_REGISTRY,
} from '@cosmosh/api-contract';

export type {
  SettingDefinition,
  SettingKey,
  SettingsJsonSchemaNode,
  SettingsCategory,
  SettingsCategoryId,
  SettingsSection,
  SettingsValues,
} from '@cosmosh/api-contract';
