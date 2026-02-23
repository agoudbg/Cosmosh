/**
 * Renderer-side re-export of the shared settings registry.
 *
 * All setting definitions, types, defaults, and helpers now live in
 * @cosmosh/api-contract/settings-registry (the single source of truth).
 * This file exists solely to keep existing import paths stable.
 */

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
  SettingsCategory,
  SettingsCategoryId,
  SettingsSection,
  SettingsValues,
} from '@cosmosh/api-contract';
