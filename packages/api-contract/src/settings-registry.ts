/**
 * Cosmosh Settings Registry — Single Source of Truth
 *
 * This file is the ONLY place where application settings are defined.
 * When adding or removing a setting:
 *   1. Add/remove the key in the `SettingsValues` interface.
 *   2. Add/remove the corresponding `SettingDefinition` entry in `SETTINGS_REGISTRY`.
 *   3. Add/remove i18n keys in locale files.
 *
 * Everything else — defaults, validation rules, UI controls, categories — is
 * derived from this registry at build/runtime.  The OpenAPI schema for
 * `SettingsValues` is intentionally left as a generic object; constraints
 * and enum sets live here exclusively.
 */

import { DEFAULT_MCP_COMMAND_POLICY, MCP_COMMAND_POLICY_OPTIONS, type McpCommandPolicy } from './mcp';
import type { GlobalServerProxyMode } from './proxy';
import {
  DEFAULT_SFTP_AUXILIARY_SIDEBAR_MODE,
  DEFAULT_SFTP_DIRECTORY_LIST_VIEW_SETTING,
  DEFAULT_SFTP_IMAGE_PREVIEW_WARNING_THRESHOLD_BYTES,
  DEFAULT_SFTP_INTERNAL_DRAG_DEFAULT_ACTION,
  DEFAULT_SFTP_INTERNAL_DRAG_MODIFIER_ACTION,
  DEFAULT_SFTP_TEXT_PREVIEW_WARNING_THRESHOLD_BYTES,
  MAX_SFTP_IMAGE_PREVIEW_WARNING_THRESHOLD_BYTES,
  MAX_SFTP_TEXT_PREVIEW_WARNING_THRESHOLD_BYTES,
  SFTP_AUXILIARY_SIDEBAR_MODES,
  SFTP_DIRECTORY_LIST_COLUMN_IDS,
  SFTP_INTERNAL_DRAG_ACTIONS,
  type SftpAuxiliarySidebarMode,
  type SftpDirectoryListViewSetting,
  type SftpInternalDragAction,
} from './sftp';
import {
  DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
  TERMINAL_CLIPBOARD_ACCESS_OPTIONS,
  type TerminalClipboardAccess,
} from './terminal-clipboard';
import {
  DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS,
  TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS,
  TERMINAL_INLINE_IMAGE_OPTION_KEYS,
  type TerminalInlineImageOptions,
} from './terminal-inline-images';
import {
  DEFAULT_TERMINAL_FORCE_SELECTION_MODIFIER,
  DEFAULT_TERMINAL_RIGHT_CLICK_ACTION,
  TERMINAL_FORCE_SELECTION_MODIFIER_OPTIONS,
  TERMINAL_RIGHT_CLICK_ACTION_OPTIONS,
  type TerminalForceSelectionModifier,
  type TerminalRightClickAction,
} from './terminal-interaction';

// ── SettingsValues — strict canonical TypeScript interface ────

export interface SettingsValues {
  language: 'en' | 'zh-CN';
  dateTimeTimeZone: string;
  dateFormat: 'yyyy-MM-dd' | 'yyyy/MM/dd' | 'dd/MM/yy' | 'MM/dd/yyyy' | 'MMM d, yyyy';
  timeFormat: 'HH:mm:ss' | 'HH:mm' | 'h:mm:ss a' | 'h:mm a';
  theme: 'dark' | 'light' | 'auto';
  windowCloseConfirmationEnabled: boolean;
  showFullServerAddress: boolean;
  sshTabApplyServerVisualStyle: boolean;
  terminalAltClickMovesCursor: boolean;
  terminalCursorBlink: boolean;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalCursorInactiveStyle: 'outline' | 'block' | 'bar' | 'underline' | 'none';
  terminalCursorStyle: 'block' | 'underline' | 'bar';
  terminalCursorWidth: string;
  terminalCustomGlyphs: boolean;
  terminalFontWeight: string;
  terminalFontWeightBold: string;
  terminalLetterSpacing: number;
  terminalLineHeight: string;
  sshMaxRows: number;
  sshConnectionTimeoutSec: number;
  serverProxyMode: GlobalServerProxyMode;
  serverProxyUrl: string;
  terminalHardwareAccelerationEnabled: boolean;
  terminalInlineImagesEnabled: boolean;
  terminalInlineImageOptions: TerminalInlineImageOptions;
  terminalCommandTimelineEnabled: boolean;
  terminalDrawBoldTextInBrightColors: boolean;
  terminalScrollSensitivity: string;
  terminalFastScrollSensitivity: string;
  terminalMinimumContrastRatio: string;
  terminalScreenReaderMode: boolean;
  terminalScrollOnUserInput: boolean;
  terminalSmoothScrollDuration: number;
  terminalTabStopWidth: number;
  remoteEnhancementsEnabled: boolean;
  remoteEnhancementsDebugEnabled: boolean;
  devToolsEnabled: boolean;
  userMenuDebugEntryEnabled: boolean;
  autoSaveEnabled: boolean;
  accountSyncEnabled: boolean;
  defaultServerNoteTemplate: string;
  terminalSelectionBarEnabled: boolean;
  terminalCopyOnSelectionEnabled: boolean;
  terminalBracketedPasteEnabled: boolean;
  terminalWarnOnMultiLinePaste: boolean;
  terminalWarnOnLargePaste: boolean;
  terminalLargePasteWarningThreshold: number;
  terminalWarnOnControlCharactersPaste: boolean;
  terminalCharacterWidthCompatibilityModeEnabled: boolean;
  terminalWebLinksEnabled: boolean;
  terminalWebLinksRequireModifierKey: boolean;
  terminalRightClickAction: TerminalRightClickAction;
  terminalRightClickSelectsWord: boolean;
  terminalForceSelectionModifier: TerminalForceSelectionModifier;
  terminalTextDropMode: 'off' | 'always' | 'external';
  localTerminalClipboardAccess: TerminalClipboardAccess;
  terminalContextLaunchBehavior: 'openDefaultLocalTerminal' | 'openLocalTerminalList' | 'off';
  defaultLocalTerminalProfile: string;
  terminalSelectionSearchEngine: 'google' | 'bing' | 'duckduckgo' | 'baidu' | 'custom';
  terminalSelectionSearchUrlTemplate: string;
  terminalAutoCompleteEnabled: boolean;
  terminalAutoCompleteHistoryEnabled: boolean;
  terminalAutoCompleteBuiltInCommandsEnabled: boolean;
  terminalAutoCompletePathEnabled: boolean;
  terminalAutoCompletePasswordEnabled: boolean;
  terminalAutoCompleteAcceptKeys: 'tab' | 'enter' | 'tabEnter';
  terminalAutoCompleteMinChars: number;
  terminalAutoCompleteMaxItems: number;
  terminalAutoCompleteFuzzyMatch: boolean;
  terminalAutoCompletePromptRegex: string;
  sshReconnectOnFocus: boolean;
  sftpReconnectMode: 'passive' | 'active' | 'off';
  sftpDeleteConfirmationMode: 'always' | 'batch' | 'shortcut' | 'off';
  sftpInternalDragDefaultAction: SftpInternalDragAction;
  sftpInternalDragModifierAction: SftpInternalDragAction;
  sftpShowHiddenEntries: boolean;
  sftpDimHiddenEntries: boolean;
  sftpShowParentDirectoryEntry: boolean;
  sftpShowAddressAsText: boolean;
  sftpAuxiliarySidebarMode: SftpAuxiliarySidebarMode;
  sftpTextPreviewWarningThresholdBytes: number;
  sftpImagePreviewWarningThresholdBytes: number;
  sftpDirectoryListView: SftpDirectoryListViewSetting;
  mcpEnabled: boolean;
  mcpListServersRequiresApproval: boolean;
  mcpCommandPolicy: McpCommandPolicy;
}

export type SettingKey = keyof SettingsValues;

// ── Category & Section Node Types ────────────────────────────

export type SettingsSection = {
  readonly labelI18nKey: string;
};

export type SettingsCategory = {
  readonly labelI18nKey: string;
  readonly sections: Readonly<Record<string, SettingsSection>>;
};

// ── Categories & Sections (Single Source of Truth) ───────────
// Key insertion order determines navigation order in the Settings UI.

export const SETTINGS_CATEGORIES = {
  general: {
    labelI18nKey: 'settings.categories.general',
    sections: {
      localization: { labelI18nKey: 'settings.sections.localization' },
      behavior: { labelI18nKey: 'settings.sections.behavior' },
    },
  },
  'account-sync': {
    labelI18nKey: 'settings.categories.account-sync',
    sections: {
      synchronization: { labelI18nKey: 'settings.sections.synchronization' },
    },
  },
  theme: {
    labelI18nKey: 'settings.categories.theme',
    sections: {
      appearance: { labelI18nKey: 'settings.sections.appearance' },
      sshStyle: { labelI18nKey: 'settings.sections.sshStyle' },
      advancedStyle: { labelI18nKey: 'settings.sections.advancedStyle' },
    },
  },
  terminal: {
    labelI18nKey: 'settings.categories.terminal',
    sections: {
      terminalSelection: {
        labelI18nKey: 'settings.sections.terminalSelection',
      },
      search: { labelI18nKey: 'settings.sections.search' },
      runtime: { labelI18nKey: 'settings.sections.runtime' },
      autoComplete: { labelI18nKey: 'settings.sections.autoComplete' },
      advancedTerminal: { labelI18nKey: 'settings.sections.advancedTerminal' },
    },
  },
  connection: {
    labelI18nKey: 'settings.categories.connection',
    sections: {
      connection: { labelI18nKey: 'settings.sections.connection' },
      proxy: { labelI18nKey: 'settings.sections.proxy' },
    },
  },
  sftp: {
    labelI18nKey: 'settings.categories.sftp',
    sections: {
      browser: { labelI18nKey: 'settings.sections.sftpBrowser' },
      safety: { labelI18nKey: 'settings.sections.sftpSafety' },
    },
  },
  mcp: {
    labelI18nKey: 'settings.categories.mcp',
    sections: {
      mcpAccess: { labelI18nKey: 'settings.sections.mcpAccess' },
      mcpPolicy: { labelI18nKey: 'settings.sections.mcpPolicy' },
    },
  },
  advanced: {
    labelI18nKey: 'settings.categories.advanced',
    sections: {
      runtime: { labelI18nKey: 'settings.sections.runtime' },
      editorDefaults: { labelI18nKey: 'settings.sections.editorDefaults' },
    },
  },
  about: {
    labelI18nKey: 'settings.categories.about',
    sections: {},
  },
} as const satisfies Record<string, SettingsCategory>;

// Derived type from the categories constant — no manual union needed.
export type SettingsCategoryId = keyof typeof SETTINGS_CATEGORIES;

// Ordered list of category IDs (mirrors key insertion order).
export const SETTINGS_CATEGORY_IDS: ReadonlyArray<SettingsCategoryId> = Object.keys(
  SETTINGS_CATEGORIES,
) as SettingsCategoryId[];

// ── Setting Definition ───────────────────────────────────────

type SettingValueType = 'string' | 'number' | 'boolean' | 'json';
type SettingSelectOption = { value: string };
type SettingDefaultValue = string | number | boolean | SftpDirectoryListViewSetting | TerminalInlineImageOptions;

export type SettingsJsonSchemaNode = {
  readonly type?: 'object' | 'array' | 'string' | 'boolean' | 'integer';
  readonly title?: string;
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly default?: unknown;
  readonly enum?: ReadonlyArray<string | number | boolean>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly items?: SettingsJsonSchemaNode;
  readonly properties?: Readonly<Record<string, SettingsJsonSchemaNode>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
};

type SettingDefinitionBase = {
  key: SettingKey;
  valueType: SettingValueType;
  defaultValue: SettingDefaultValue;
  nameI18nKey: string;
  descriptionI18nKey: string;
  category: SettingsCategory;
  section: SettingsSection;
  path: string;
  commandActionId: string;
  searchTerms: string[];
  inputMode?: 'text' | 'none' | 'search' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal';
  min?: number;
  max?: number;
  maxLength?: number;
};

type SelectSettingDefinition = SettingDefinitionBase & {
  control: 'select';
  optionI18nNamespace?: string;
  options?: SettingSelectOption[];
  placeholderI18nKey?: never;
};

type InputLikeSettingDefinition = SettingDefinitionBase & {
  control: 'input' | 'textarea';
  placeholderI18nKey?: string;
  optionI18nNamespace?: never;
  options?: never;
};

type SwitchSettingDefinition = SettingDefinitionBase & {
  control: 'switch';
  optionI18nNamespace?: never;
  options?: never;
  placeholderI18nKey?: never;
};

type JsonSettingDefinition = SettingDefinitionBase & {
  valueType: 'json';
  control: 'json';
  defaultValue: SftpDirectoryListViewSetting | TerminalInlineImageOptions;
  jsonSchema: SettingsJsonSchemaNode;
  optionI18nNamespace?: never;
  options?: never;
  placeholderI18nKey?: never;
};

export type SettingDefinition =
  SelectSettingDefinition | InputLikeSettingDefinition | SwitchSettingDefinition | JsonSettingDefinition;

const createTerminalInlineImageOptionsSchemaProperties = (): Readonly<Record<string, SettingsJsonSchemaNode>> => ({
  enableSizeReports: {
    type: 'boolean',
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.enableSizeReports,
    description: 'Enable CSI window/cell size reports used by inline image-capable programs.',
  },
  pixelLimit: {
    type: 'integer',
    minimum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.pixelLimit.minimum,
    maximum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.pixelLimit.maximum,
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.pixelLimit,
    description: 'Maximum decoded pixel count for a single image.',
  },
  sixelSupport: {
    type: 'boolean',
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.sixelSupport,
    description: 'Enable SIXEL image sequence parsing.',
  },
  sixelScrolling: {
    type: 'boolean',
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.sixelScrolling,
    description: 'Allow SIXEL output to scroll the terminal buffer.',
  },
  sixelPaletteLimit: {
    type: 'integer',
    minimum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.sixelPaletteLimit.minimum,
    maximum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.sixelPaletteLimit.maximum,
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.sixelPaletteLimit,
    description: 'Maximum initial SIXEL palette size.',
  },
  sixelSizeLimit: {
    type: 'integer',
    minimum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.sixelSizeLimit.minimum,
    maximum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.sixelSizeLimit.maximum,
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.sixelSizeLimit,
    description: 'Maximum byte size of a single SIXEL sequence.',
  },
  storageLimit: {
    type: 'integer',
    minimum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.storageLimit.minimum,
    maximum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.storageLimit.maximum,
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.storageLimit,
    description: 'FIFO inline image storage limit in MB.',
  },
  showPlaceholder: {
    type: 'boolean',
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.showPlaceholder,
    description: 'Show placeholders for images evicted from the addon storage cache.',
  },
  iipSupport: {
    type: 'boolean',
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.iipSupport,
    description: 'Enable iTerm inline image protocol parsing.',
  },
  iipSizeLimit: {
    type: 'integer',
    minimum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.iipSizeLimit.minimum,
    maximum: TERMINAL_INLINE_IMAGE_INTEGER_OPTION_LIMITS.iipSizeLimit.maximum,
    default: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS.iipSizeLimit,
    description: 'Maximum byte size of a single iTerm inline image protocol sequence.',
  },
});

// ── The Registry ─────────────────────────────────────────────

export const SETTINGS_REGISTRY: ReadonlyArray<SettingDefinition> = [
  {
    key: 'language',
    valueType: 'string',
    defaultValue: 'en',
    nameI18nKey: 'settings.items.language.title',
    descriptionI18nKey: 'settings.items.language.description',
    optionI18nNamespace: 'language',
    category: SETTINGS_CATEGORIES.general,
    section: SETTINGS_CATEGORIES.general.sections.localization,
    control: 'select',
    path: 'general.language',
    commandActionId: 'settings.general.language.set',
    searchTerms: ['language', 'locale', 'ui language', 'english', 'chinese'],
    options: [{ value: 'en' }, { value: 'zh-CN' }],
  },
  {
    key: 'dateTimeTimeZone',
    valueType: 'string',
    defaultValue: 'system',
    nameI18nKey: 'settings.items.dateTimeTimeZone.title',
    descriptionI18nKey: 'settings.items.dateTimeTimeZone.description',
    optionI18nNamespace: 'dateTimeTimeZone',
    category: SETTINGS_CATEGORIES.general,
    section: SETTINGS_CATEGORIES.general.sections.localization,
    control: 'select',
    path: 'general.dateTime.timeZone',
    commandActionId: 'settings.general.dateTime.timeZone.set',
    searchTerms: ['time', 'date', 'timezone', 'time zone', 'iana', 'utc', 'local time'],
    maxLength: 100,
  },
  {
    key: 'dateFormat',
    valueType: 'string',
    defaultValue: 'yyyy-MM-dd',
    nameI18nKey: 'settings.items.dateFormat.title',
    descriptionI18nKey: 'settings.items.dateFormat.description',
    optionI18nNamespace: 'dateFormat',
    category: SETTINGS_CATEGORIES.general,
    section: SETTINGS_CATEGORIES.general.sections.localization,
    control: 'select',
    path: 'general.dateTime.dateFormat',
    commandActionId: 'settings.general.dateTime.dateFormat.set',
    searchTerms: ['date', 'format', 'yyyy', 'month', 'day'],
    options: [
      { value: 'yyyy-MM-dd' },
      { value: 'yyyy/MM/dd' },
      { value: 'dd/MM/yy' },
      { value: 'MM/dd/yyyy' },
      { value: 'MMM d, yyyy' },
    ],
  },
  {
    key: 'timeFormat',
    valueType: 'string',
    defaultValue: 'HH:mm:ss',
    nameI18nKey: 'settings.items.timeFormat.title',
    descriptionI18nKey: 'settings.items.timeFormat.description',
    optionI18nNamespace: 'timeFormat',
    category: SETTINGS_CATEGORIES.general,
    section: SETTINGS_CATEGORIES.general.sections.localization,
    control: 'select',
    path: 'general.dateTime.timeFormat',
    commandActionId: 'settings.general.dateTime.timeFormat.set',
    searchTerms: ['time', 'format', 'clock', '12 hour', '24 hour', 'seconds'],
    options: [{ value: 'HH:mm:ss' }, { value: 'HH:mm' }, { value: 'h:mm:ss a' }, { value: 'h:mm a' }],
  },
  {
    key: 'windowCloseConfirmationEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.windowCloseConfirmationEnabled.title',
    descriptionI18nKey: 'settings.items.windowCloseConfirmationEnabled.description',
    category: SETTINGS_CATEGORIES.general,
    section: SETTINGS_CATEGORIES.general.sections.behavior,
    control: 'switch',
    path: 'general.window.closeConfirmationEnabled',
    commandActionId: 'settings.general.window.closeConfirmation.toggle',
    searchTerms: ['window', 'close', 'confirmation', 'prompt', 'active session', 'quit'],
  },
  {
    key: 'accountSyncEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.accountSyncEnabled.title',
    descriptionI18nKey: 'settings.items.accountSyncEnabled.description',
    optionI18nNamespace: 'boolean',
    category: SETTINGS_CATEGORIES['account-sync'],
    section: SETTINGS_CATEGORIES['account-sync'].sections.synchronization,
    control: 'select',
    path: 'account.sync.enabled',
    commandActionId: 'settings.account.sync.toggle',
    searchTerms: ['sync', 'account sync', 'cloud sync'],
    options: [{ value: 'true' }, { value: 'false' }],
  },
  {
    key: 'theme',
    valueType: 'string',
    defaultValue: 'dark',
    nameI18nKey: 'settings.items.theme.title',
    descriptionI18nKey: 'settings.items.theme.description',
    optionI18nNamespace: 'theme',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.appearance,
    control: 'select',
    path: 'theme.mode',
    commandActionId: 'settings.theme.mode.set',
    searchTerms: ['theme', 'appearance', 'dark', 'light', 'auto'],
    options: [{ value: 'dark' }, { value: 'light' }, { value: 'auto' }],
  },
  {
    key: 'terminalAltClickMovesCursor',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAltClickMovesCursor.title',
    descriptionI18nKey: 'settings.items.terminalAltClickMovesCursor.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'switch',
    path: 'theme.ssh.altClickMovesCursor',
    commandActionId: 'settings.theme.ssh.altClickMovesCursor.toggle',
    searchTerms: ['terminal', 'alt click', 'cursor', 'ssh style'],
  },
  {
    key: 'terminalCursorBlink',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalCursorBlink.title',
    descriptionI18nKey: 'settings.items.terminalCursorBlink.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'switch',
    path: 'theme.ssh.cursorBlink',
    commandActionId: 'settings.theme.ssh.cursorBlink.toggle',
    searchTerms: ['terminal', 'cursor', 'blink', 'ssh style'],
  },
  {
    key: 'terminalFontFamily',
    valueType: 'string',
    defaultValue:
      'Consolas, "JetBrains Mono", "Liberation Mono", "Microsoft YaHei", "SFMono-Regular", "PingFang SC", monospace',
    nameI18nKey: 'settings.items.terminalFontFamily.title',
    descriptionI18nKey: 'settings.items.terminalFontFamily.description',
    placeholderI18nKey: 'settings.items.terminalFontFamily.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'input',
    path: 'theme.ssh.fontFamily',
    commandActionId: 'settings.theme.ssh.fontFamily.set',
    searchTerms: ['terminal', 'font family', 'yahei', 'pingfang', 'consolas'],
    maxLength: 1000,
  },
  {
    key: 'terminalFontSize',
    valueType: 'number',
    defaultValue: 15,
    nameI18nKey: 'settings.items.terminalFontSize.title',
    descriptionI18nKey: 'settings.items.terminalFontSize.description',
    placeholderI18nKey: 'settings.items.terminalFontSize.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'input',
    path: 'theme.ssh.fontSize',
    commandActionId: 'settings.theme.ssh.fontSize.set',
    searchTerms: ['terminal', 'font size', 'ssh style'],
    inputMode: 'numeric',
    min: 9,
    max: 36,
  },
  {
    key: 'sshMaxRows',
    valueType: 'number',
    defaultValue: 10000,
    nameI18nKey: 'settings.items.sshMaxRows.title',
    descriptionI18nKey: 'settings.items.sshMaxRows.description',
    placeholderI18nKey: 'settings.items.sshMaxRows.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'input',
    path: 'terminal.runtime.maxRows',
    commandActionId: 'settings.terminal.runtime.maxRows.set',
    searchTerms: ['ssh', 'max rows', 'terminal lines', 'scrollback', 'terminal'],
    inputMode: 'numeric',
    min: 100,
    max: 200000,
  },
  {
    key: 'sshConnectionTimeoutSec',
    valueType: 'number',
    defaultValue: 45,
    nameI18nKey: 'settings.items.sshConnectionTimeoutSec.title',
    descriptionI18nKey: 'settings.items.sshConnectionTimeoutSec.description',
    placeholderI18nKey: 'settings.items.sshConnectionTimeoutSec.placeholder',
    category: SETTINGS_CATEGORIES.connection,
    section: SETTINGS_CATEGORIES.connection.sections.connection,
    control: 'input',
    path: 'connection.ssh.timeoutSec',
    commandActionId: 'settings.connection.ssh.timeout.set',
    searchTerms: ['ssh', 'timeout', 'connection timeout'],
    inputMode: 'numeric',
    min: 5,
    max: 180,
  },
  {
    key: 'sshReconnectOnFocus',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.sshReconnectOnFocus.title',
    descriptionI18nKey: 'settings.items.sshReconnectOnFocus.description',
    category: SETTINGS_CATEGORIES.connection,
    section: SETTINGS_CATEGORIES.connection.sections.connection,
    control: 'switch',
    path: 'connection.ssh.reconnectOnFocus',
    commandActionId: 'settings.connection.ssh.reconnectOnFocus.toggle',
    searchTerms: ['ssh', 'reconnect', 'tab', 'focus', 'auto reconnect', 'connection'],
  },
  {
    key: 'serverProxyMode',
    valueType: 'string',
    defaultValue: 'system',
    nameI18nKey: 'settings.items.serverProxyMode.title',
    descriptionI18nKey: 'settings.items.serverProxyMode.description',
    optionI18nNamespace: 'serverProxyMode',
    category: SETTINGS_CATEGORIES.connection,
    section: SETTINGS_CATEGORIES.connection.sections.proxy,
    control: 'select',
    path: 'connection.proxy.mode',
    commandActionId: 'settings.connection.proxy.mode.set',
    searchTerms: ['proxy', 'system proxy', 'server connection', 'socks5', 'http connect'],
    options: [{ value: 'off' }, { value: 'system' }, { value: 'custom' }],
  },
  {
    key: 'serverProxyUrl',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.serverProxyUrl.title',
    descriptionI18nKey: 'settings.items.serverProxyUrl.description',
    placeholderI18nKey: 'settings.items.serverProxyUrl.placeholder',
    category: SETTINGS_CATEGORIES.connection,
    section: SETTINGS_CATEGORIES.connection.sections.proxy,
    control: 'input',
    path: 'connection.proxy.url',
    commandActionId: 'settings.connection.proxy.url.set',
    searchTerms: ['proxy url', 'http proxy', 'https proxy', 'socks5 proxy', 'authentication'],
    inputMode: 'url',
    maxLength: 2048,
  },
  {
    key: 'sftpReconnectMode',
    valueType: 'string',
    defaultValue: 'passive',
    nameI18nKey: 'settings.items.sftpReconnectMode.title',
    descriptionI18nKey: 'settings.items.sftpReconnectMode.description',
    optionI18nNamespace: 'sftpReconnectMode',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.safety,
    control: 'select',
    path: 'sftp.safety.reconnectMode',
    commandActionId: 'settings.sftp.safety.reconnectMode.set',
    searchTerms: ['sftp', 'reconnect', 'disconnect', 'auto reconnect', 'connection', 'passive', 'active'],
    options: [{ value: 'passive' }, { value: 'active' }, { value: 'off' }],
  },
  {
    key: 'sftpDeleteConfirmationMode',
    valueType: 'string',
    defaultValue: 'always',
    nameI18nKey: 'settings.items.sftpDeleteConfirmationMode.title',
    descriptionI18nKey: 'settings.items.sftpDeleteConfirmationMode.description',
    optionI18nNamespace: 'sftpDeleteConfirmationMode',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.safety,
    control: 'select',
    path: 'sftp.safety.deleteConfirmationMode',
    commandActionId: 'settings.sftp.safety.deleteConfirmationMode.set',
    searchTerms: ['sftp', 'delete', 'confirm', 'confirmation', 'batch', 'shortcut', 'safety'],
    options: [{ value: 'always' }, { value: 'batch' }, { value: 'shortcut' }, { value: 'off' }],
  },
  {
    key: 'sftpInternalDragDefaultAction',
    valueType: 'string',
    defaultValue: DEFAULT_SFTP_INTERNAL_DRAG_DEFAULT_ACTION,
    nameI18nKey: 'settings.items.sftpInternalDragDefaultAction.title',
    descriptionI18nKey: 'settings.items.sftpInternalDragDefaultAction.description',
    optionI18nNamespace: 'sftpDragAction',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'select',
    path: 'sftp.browser.internalDragDefaultAction',
    commandActionId: 'settings.sftp.browser.internalDragDefaultAction.set',
    searchTerms: ['sftp', 'drag', 'drop', 'move', 'copy', 'link', 'ask', 'browser'],
    options: SFTP_INTERNAL_DRAG_ACTIONS.map((value) => ({ value })),
  },
  {
    key: 'sftpInternalDragModifierAction',
    valueType: 'string',
    defaultValue: DEFAULT_SFTP_INTERNAL_DRAG_MODIFIER_ACTION,
    nameI18nKey: 'settings.items.sftpInternalDragModifierAction.title',
    descriptionI18nKey: 'settings.items.sftpInternalDragModifierAction.description',
    optionI18nNamespace: 'sftpDragAction',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'select',
    path: 'sftp.browser.internalDragModifierAction',
    commandActionId: 'settings.sftp.browser.internalDragModifierAction.set',
    searchTerms: ['sftp', 'drag', 'drop', 'modifier', 'ctrl', 'cmd', 'move', 'copy', 'link', 'ask'],
    options: SFTP_INTERNAL_DRAG_ACTIONS.map((value) => ({ value })),
  },
  {
    key: 'sftpShowHiddenEntries',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.sftpShowHiddenEntries.title',
    descriptionI18nKey: 'settings.items.sftpShowHiddenEntries.description',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'switch',
    path: 'sftp.browser.showHiddenEntries',
    commandActionId: 'settings.sftp.browser.showHiddenEntries.toggle',
    searchTerms: ['sftp', 'hidden', 'dotfile', 'dotfiles', 'file list', 'tree', 'browser'],
  },
  {
    key: 'sftpDimHiddenEntries',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.sftpDimHiddenEntries.title',
    descriptionI18nKey: 'settings.items.sftpDimHiddenEntries.description',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'switch',
    path: 'sftp.browser.dimHiddenEntries',
    commandActionId: 'settings.sftp.browser.dimHiddenEntries.toggle',
    searchTerms: ['sftp', 'hidden', 'dim', 'faded', 'file list', 'tree', 'browser'],
  },
  {
    key: 'sftpShowParentDirectoryEntry',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.sftpShowParentDirectoryEntry.title',
    descriptionI18nKey: 'settings.items.sftpShowParentDirectoryEntry.description',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'switch',
    path: 'sftp.browser.showParentDirectoryEntry',
    commandActionId: 'settings.sftp.browser.showParentDirectoryEntry.toggle',
    searchTerms: ['sftp', 'parent directory', 'up', '..', 'file list', 'browser'],
  },
  {
    key: 'sftpShowAddressAsText',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.sftpShowAddressAsText.title',
    descriptionI18nKey: 'settings.items.sftpShowAddressAsText.description',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'switch',
    path: 'sftp.browser.showAddressAsText',
    commandActionId: 'settings.sftp.browser.showAddressAsText.toggle',
    searchTerms: ['sftp', 'address', 'path', 'breadcrumb', 'text', 'browser'],
  },
  {
    key: 'sftpAuxiliarySidebarMode',
    valueType: 'string',
    defaultValue: DEFAULT_SFTP_AUXILIARY_SIDEBAR_MODE,
    nameI18nKey: 'settings.items.sftpAuxiliarySidebarMode.title',
    descriptionI18nKey: 'settings.items.sftpAuxiliarySidebarMode.description',
    optionI18nNamespace: 'sftpAuxiliarySidebarMode',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'select',
    path: 'sftp.browser.auxiliarySidebarMode',
    commandActionId: 'settings.sftp.browser.auxiliarySidebarMode.set',
    searchTerms: ['sftp', 'auxiliary sidebar', 'details', 'preview', 'side panel', 'file preview'],
    options: SFTP_AUXILIARY_SIDEBAR_MODES.map((value) => ({ value })),
  },
  {
    key: 'sftpTextPreviewWarningThresholdBytes',
    valueType: 'number',
    defaultValue: DEFAULT_SFTP_TEXT_PREVIEW_WARNING_THRESHOLD_BYTES,
    nameI18nKey: 'settings.items.sftpTextPreviewWarningThresholdBytes.title',
    descriptionI18nKey: 'settings.items.sftpTextPreviewWarningThresholdBytes.description',
    placeholderI18nKey: 'settings.items.sftpTextPreviewWarningThresholdBytes.placeholder',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'input',
    path: 'sftp.browser.textPreviewWarningThresholdBytes',
    commandActionId: 'settings.sftp.browser.textPreviewWarningThresholdBytes.set',
    searchTerms: ['sftp', 'preview', 'codemirror', 'text', 'code', 'large file', 'threshold'],
    inputMode: 'numeric',
    min: 1024,
    max: MAX_SFTP_TEXT_PREVIEW_WARNING_THRESHOLD_BYTES,
  },
  {
    key: 'sftpImagePreviewWarningThresholdBytes',
    valueType: 'number',
    defaultValue: DEFAULT_SFTP_IMAGE_PREVIEW_WARNING_THRESHOLD_BYTES,
    nameI18nKey: 'settings.items.sftpImagePreviewWarningThresholdBytes.title',
    descriptionI18nKey: 'settings.items.sftpImagePreviewWarningThresholdBytes.description',
    placeholderI18nKey: 'settings.items.sftpImagePreviewWarningThresholdBytes.placeholder',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'input',
    path: 'sftp.browser.imagePreviewWarningThresholdBytes',
    commandActionId: 'settings.sftp.browser.imagePreviewWarningThresholdBytes.set',
    searchTerms: ['sftp', 'preview', 'image', 'large image', 'download', 'threshold'],
    inputMode: 'numeric',
    min: 1024,
    max: MAX_SFTP_IMAGE_PREVIEW_WARNING_THRESHOLD_BYTES,
  },
  {
    key: 'sftpDirectoryListView',
    valueType: 'json',
    defaultValue: DEFAULT_SFTP_DIRECTORY_LIST_VIEW_SETTING,
    nameI18nKey: 'settings.items.sftpDirectoryListView.title',
    descriptionI18nKey: 'settings.items.sftpDirectoryListView.description',
    category: SETTINGS_CATEGORIES.sftp,
    section: SETTINGS_CATEGORIES.sftp.sections.browser,
    control: 'json',
    path: 'sftp.browser.directoryListView',
    commandActionId: 'settings.sftp.browser.directoryListView.edit',
    searchTerms: ['sftp', 'file list', 'directory list', 'columns', 'sort', 'json', 'metadata'],
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'columns', 'sort'],
      properties: {
        version: {
          type: 'integer',
          enum: [1],
          default: 1,
        },
        columns: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'visible'],
            properties: {
              id: {
                type: 'string',
                enum: SFTP_DIRECTORY_LIST_COLUMN_IDS,
              },
              visible: {
                type: 'boolean',
              },
            },
          },
        },
        sort: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'direction'],
          properties: {
            field: {
              type: 'string',
              enum: SFTP_DIRECTORY_LIST_COLUMN_IDS,
            },
            direction: {
              type: 'string',
              enum: ['asc', 'desc'],
            },
          },
        },
      },
    },
  },
  {
    key: 'showFullServerAddress',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.showFullServerAddress.title',
    descriptionI18nKey: 'settings.items.showFullServerAddress.description',
    category: SETTINGS_CATEGORIES.general,
    section: SETTINGS_CATEGORIES.general.sections.localization,
    control: 'switch',
    path: 'general.server.showFullServerAddress',
    commandActionId: 'settings.general.server.showFullServerAddress.toggle',
    searchTerms: ['ssh', 'server address', 'host', 'ip', 'mask', 'privacy'],
  },
  {
    key: 'sshTabApplyServerVisualStyle',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.sshTabApplyServerVisualStyle.title',
    descriptionI18nKey: 'settings.items.sshTabApplyServerVisualStyle.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.appearance,
    control: 'switch',
    path: 'theme.tabs.ssh.applyServerVisualStyle',
    commandActionId: 'settings.theme.tabs.ssh.applyServerVisualStyle.toggle',
    searchTerms: ['ssh', 'sftp', 'tab icon', 'server icon', 'icon color', 'tab appearance'],
  },
  {
    key: 'terminalCursorInactiveStyle',
    valueType: 'string',
    defaultValue: 'outline',
    nameI18nKey: 'settings.items.terminalCursorInactiveStyle.title',
    descriptionI18nKey: 'settings.items.terminalCursorInactiveStyle.description',
    optionI18nNamespace: 'terminalCursorInactiveStyle',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'select',
    path: 'theme.ssh.advanced.cursorInactiveStyle',
    commandActionId: 'settings.theme.ssh.advanced.cursorInactiveStyle.set',
    searchTerms: ['terminal', 'cursor', 'inactive', 'advanced style'],
    options: [{ value: 'outline' }, { value: 'block' }, { value: 'bar' }, { value: 'underline' }, { value: 'none' }],
  },
  {
    key: 'terminalCursorStyle',
    valueType: 'string',
    defaultValue: 'block',
    nameI18nKey: 'settings.items.terminalCursorStyle.title',
    descriptionI18nKey: 'settings.items.terminalCursorStyle.description',
    optionI18nNamespace: 'terminalCursorStyle',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'select',
    path: 'theme.ssh.advanced.cursorStyle',
    commandActionId: 'settings.theme.ssh.advanced.cursorStyle.set',
    searchTerms: ['terminal', 'cursor', 'style', 'advanced style'],
    options: [{ value: 'block' }, { value: 'underline' }, { value: 'bar' }],
  },
  {
    key: 'terminalCursorWidth',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.terminalCursorWidth.title',
    descriptionI18nKey: 'settings.items.terminalCursorWidth.description',
    placeholderI18nKey: 'settings.items.terminalCursorWidth.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.cursorWidth',
    commandActionId: 'settings.theme.ssh.advanced.cursorWidth.set',
    searchTerms: ['terminal', 'cursor', 'width', 'advanced style'],
    inputMode: 'numeric',
    maxLength: 8,
  },
  {
    key: 'terminalCustomGlyphs',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalCustomGlyphs.title',
    descriptionI18nKey: 'settings.items.terminalCustomGlyphs.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'switch',
    path: 'theme.ssh.advanced.customGlyphs',
    commandActionId: 'settings.theme.ssh.advanced.customGlyphs.toggle',
    searchTerms: ['terminal', 'custom glyphs', 'advanced style'],
  },
  {
    key: 'terminalFontWeight',
    valueType: 'string',
    defaultValue: 'normal',
    nameI18nKey: 'settings.items.terminalFontWeight.title',
    descriptionI18nKey: 'settings.items.terminalFontWeight.description',
    placeholderI18nKey: 'settings.items.terminalFontWeight.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.fontWeight',
    commandActionId: 'settings.theme.ssh.advanced.fontWeight.set',
    searchTerms: ['terminal', 'font weight', 'advanced style'],
    maxLength: 16,
  },
  {
    key: 'terminalFontWeightBold',
    valueType: 'string',
    defaultValue: 'bold',
    nameI18nKey: 'settings.items.terminalFontWeightBold.title',
    descriptionI18nKey: 'settings.items.terminalFontWeightBold.description',
    placeholderI18nKey: 'settings.items.terminalFontWeightBold.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.fontWeightBold',
    commandActionId: 'settings.theme.ssh.advanced.fontWeightBold.set',
    searchTerms: ['terminal', 'font weight bold', 'advanced style'],
    maxLength: 16,
  },
  {
    key: 'terminalLetterSpacing',
    valueType: 'number',
    defaultValue: 0,
    nameI18nKey: 'settings.items.terminalLetterSpacing.title',
    descriptionI18nKey: 'settings.items.terminalLetterSpacing.description',
    placeholderI18nKey: 'settings.items.terminalLetterSpacing.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.letterSpacing',
    commandActionId: 'settings.theme.ssh.advanced.letterSpacing.set',
    searchTerms: ['terminal', 'letter spacing', 'advanced style'],
    inputMode: 'numeric',
    min: -5,
    max: 20,
  },
  {
    key: 'terminalLineHeight',
    valueType: 'string',
    defaultValue: '1',
    nameI18nKey: 'settings.items.terminalLineHeight.title',
    descriptionI18nKey: 'settings.items.terminalLineHeight.description',
    placeholderI18nKey: 'settings.items.terminalLineHeight.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.lineHeight',
    commandActionId: 'settings.theme.ssh.advanced.lineHeight.set',
    searchTerms: ['terminal', 'line height', 'advanced style'],
    inputMode: 'decimal',
    maxLength: 16,
  },
  {
    key: 'autoSaveEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.autoSaveEnabled.title',
    descriptionI18nKey: 'settings.items.autoSaveEnabled.description',
    optionI18nNamespace: 'boolean',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.editorDefaults,
    control: 'select',
    path: 'advanced.editor.autoSaveEnabled',
    commandActionId: 'settings.advanced.editor.autoSave.toggle',
    searchTerms: ['auto save', 'autosave', 'save automatically'],
    options: [{ value: 'true' }, { value: 'false' }],
  },
  {
    key: 'remoteEnhancementsEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.remoteEnhancementsEnabled.title',
    descriptionI18nKey: 'settings.items.remoteEnhancementsEnabled.description',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.runtime,
    control: 'switch',
    path: 'advanced.runtime.remoteEnhancements.enabled',
    commandActionId: 'settings.advanced.runtime.remoteEnhancements.enabled.toggle',
    searchTerms: [
      'remote enhancements',
      'remote bootstrap',
      'bootstrap',
      'os detection',
      'sftp enhancement',
      'command completion',
    ],
  },
  {
    key: 'remoteEnhancementsDebugEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.remoteEnhancementsDebugEnabled.title',
    descriptionI18nKey: 'settings.items.remoteEnhancementsDebugEnabled.description',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.runtime,
    control: 'switch',
    path: 'advanced.runtime.remoteEnhancements.debugEnabled',
    commandActionId: 'settings.advanced.runtime.remoteEnhancements.debugEnabled.toggle',
    searchTerms: ['remote enhancements debug', 'helper events', 'bootstrap diagnostics', 'shell integration debug'],
  },
  {
    key: 'devToolsEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.devToolsEnabled.title',
    descriptionI18nKey: 'settings.items.devToolsEnabled.description',
    optionI18nNamespace: 'boolean',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.runtime,
    control: 'select',
    path: 'advanced.runtime.devToolsEnabled',
    commandActionId: 'settings.advanced.runtime.devTools.toggle',
    searchTerms: ['devtools', 'developer tools', 'debug tools', 'ctrl+shift+i'],
    options: [{ value: 'true' }, { value: 'false' }],
  },
  {
    key: 'userMenuDebugEntryEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.userMenuDebugEntryEnabled.title',
    descriptionI18nKey: 'settings.items.userMenuDebugEntryEnabled.description',
    optionI18nNamespace: 'boolean',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.runtime,
    control: 'select',
    path: 'advanced.runtime.userMenuDebugEntryEnabled',
    commandActionId: 'settings.advanced.runtime.userMenuDebugEntry.toggle',
    searchTerms: ['debug menu', 'user menu', 'profile menu', 'advanced debug'],
    options: [{ value: 'true' }, { value: 'false' }],
  },
  {
    key: 'defaultServerNoteTemplate',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.defaultServerNoteTemplate.title',
    descriptionI18nKey: 'settings.items.defaultServerNoteTemplate.description',
    placeholderI18nKey: 'settings.items.defaultServerNoteTemplate.placeholder',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.editorDefaults,
    control: 'textarea',
    path: 'advanced.editor.defaultServerNoteTemplate',
    commandActionId: 'settings.advanced.editor.defaultServerNoteTemplate.set',
    searchTerms: ['template', 'note', 'server note', 'editor defaults'],
    maxLength: 1000,
  },
  {
    key: 'terminalSelectionBarEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalSelectionBarEnabled.title',
    descriptionI18nKey: 'settings.items.terminalSelectionBarEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.terminalSelection,
    control: 'switch',
    path: 'terminal.selection.toolbar.enabled',
    commandActionId: 'settings.terminal.selection.toolbar.toggle',
    searchTerms: ['terminal', 'orbit bar', 'floating bar', 'enable orbit bar'],
  },
  {
    key: 'terminalCopyOnSelectionEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.terminalCopyOnSelectionEnabled.title',
    descriptionI18nKey: 'settings.items.terminalCopyOnSelectionEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.terminalSelection,
    control: 'switch',
    path: 'terminal.selection.copyOnSelection.enabled',
    commandActionId: 'settings.terminal.selection.copyOnSelection.enabled.toggle',
    searchTerms: ['terminal', 'selection', 'copy on selection', 'clipboard', 'mouse selection'],
  },
  {
    key: 'terminalTextDropMode',
    valueType: 'string',
    defaultValue: 'external',
    nameI18nKey: 'settings.items.terminalTextDropMode.title',
    descriptionI18nKey: 'settings.items.terminalTextDropMode.description',
    optionI18nNamespace: 'terminalTextDropMode',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.textDropMode',
    commandActionId: 'settings.terminal.runtime.textDropMode.set',
    searchTerms: ['terminal', 'drag', 'drop', 'text drop', 'external drag'],
    options: [{ value: 'off' }, { value: 'always' }, { value: 'external' }],
  },
  {
    key: 'terminalHardwareAccelerationEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalHardwareAccelerationEnabled.title',
    descriptionI18nKey: 'settings.items.terminalHardwareAccelerationEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.hardwareAcceleration.enabled',
    commandActionId: 'settings.terminal.runtime.hardwareAcceleration.enabled.toggle',
    searchTerms: ['terminal', 'hardware acceleration', 'webgl', 'gpu', 'renderer'],
  },
  {
    key: 'terminalInlineImagesEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.terminalInlineImagesEnabled.title',
    descriptionI18nKey: 'settings.items.terminalInlineImagesEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.inlineImages.enabled',
    commandActionId: 'settings.terminal.runtime.inlineImages.enabled.toggle',
    searchTerms: ['terminal', 'inline image', 'image', 'sixel', 'iterm', 'iip', 'experimental'],
  },
  {
    key: 'terminalInlineImageOptions',
    valueType: 'json',
    defaultValue: DEFAULT_TERMINAL_INLINE_IMAGE_OPTIONS,
    nameI18nKey: 'settings.items.terminalInlineImageOptions.title',
    descriptionI18nKey: 'settings.items.terminalInlineImageOptions.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'json',
    path: 'terminal.runtime.inlineImages.options',
    commandActionId: 'settings.terminal.runtime.inlineImages.options.edit',
    searchTerms: ['terminal', 'inline image', 'image options', 'sixel limit', 'iterm iip', 'json'],
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: TERMINAL_INLINE_IMAGE_OPTION_KEYS,
      properties: createTerminalInlineImageOptionsSchemaProperties(),
    },
  },
  {
    key: 'terminalBracketedPasteEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalBracketedPasteEnabled.title',
    descriptionI18nKey: 'settings.items.terminalBracketedPasteEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.bracketedPaste.enabled',
    commandActionId: 'settings.terminal.runtime.bracketedPaste.enabled.toggle',
    searchTerms: ['terminal', 'paste', 'multiline paste', 'safe paste', 'bracketed paste'],
  },
  {
    key: 'terminalWarnOnMultiLinePaste',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalWarnOnMultiLinePaste.title',
    descriptionI18nKey: 'settings.items.terminalWarnOnMultiLinePaste.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.pasteWarning.multiLine.enabled',
    commandActionId: 'settings.terminal.runtime.pasteWarning.multiLine.enabled.toggle',
    searchTerms: ['terminal', 'paste warning', 'multiline paste', 'multi line', 'safety'],
  },
  {
    key: 'terminalWarnOnLargePaste',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalWarnOnLargePaste.title',
    descriptionI18nKey: 'settings.items.terminalWarnOnLargePaste.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.pasteWarning.large.enabled',
    commandActionId: 'settings.terminal.runtime.pasteWarning.large.enabled.toggle',
    searchTerms: ['terminal', 'paste warning', 'large paste', 'big paste', 'safety'],
  },
  {
    key: 'terminalLargePasteWarningThreshold',
    valueType: 'number',
    defaultValue: 5120,
    nameI18nKey: 'settings.items.terminalLargePasteWarningThreshold.title',
    descriptionI18nKey: 'settings.items.terminalLargePasteWarningThreshold.description',
    placeholderI18nKey: 'settings.items.terminalLargePasteWarningThreshold.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'input',
    path: 'terminal.runtime.pasteWarning.large.threshold',
    commandActionId: 'settings.terminal.runtime.pasteWarning.large.threshold.set',
    searchTerms: ['terminal', 'paste warning', 'large paste', 'threshold', 'bytes', 'characters'],
    inputMode: 'numeric',
    min: 1,
    max: 1000000,
  },
  {
    key: 'terminalWarnOnControlCharactersPaste',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalWarnOnControlCharactersPaste.title',
    descriptionI18nKey: 'settings.items.terminalWarnOnControlCharactersPaste.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.pasteWarning.controlCharacters.enabled',
    commandActionId: 'settings.terminal.runtime.pasteWarning.controlCharacters.enabled.toggle',
    searchTerms: ['terminal', 'paste warning', 'control characters', 'escape', 'bel', 'ansi sequence', 'safety'],
  },
  {
    key: 'terminalCharacterWidthCompatibilityModeEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalCharacterWidthCompatibilityModeEnabled.title',
    descriptionI18nKey: 'settings.items.terminalCharacterWidthCompatibilityModeEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.characterWidthCompatibilityMode.enabled',
    commandActionId: 'settings.terminal.runtime.characterWidthCompatibilityMode.enabled.toggle',
    searchTerms: ['terminal', 'unicode 11', 'character width', 'width compatibility', 'alignment'],
  },
  {
    key: 'terminalCommandTimelineEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalCommandTimelineEnabled.title',
    descriptionI18nKey: 'settings.items.terminalCommandTimelineEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.commandTimeline.enabled',
    commandActionId: 'settings.terminal.runtime.commandTimeline.enabled.toggle',
    searchTerms: ['terminal', 'command timeline', 'recent commands', 'command history', 'remote enhancements'],
  },
  {
    key: 'terminalWebLinksEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalWebLinksEnabled.title',
    descriptionI18nKey: 'settings.items.terminalWebLinksEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.webLinks.enabled',
    commandActionId: 'settings.terminal.runtime.webLinks.enabled.toggle',
    searchTerms: ['terminal', 'links', 'web links', 'url', 'open url', 'click link'],
  },
  {
    key: 'terminalWebLinksRequireModifierKey',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalWebLinksRequireModifierKey.title',
    descriptionI18nKey: 'settings.items.terminalWebLinksRequireModifierKey.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.webLinks.requireModifierKey',
    commandActionId: 'settings.terminal.runtime.webLinks.requireModifierKey.toggle',
    searchTerms: ['terminal', 'links', 'web links', 'url', 'ctrl click', 'cmd click', 'modifier click'],
  },
  {
    key: 'terminalRightClickAction',
    valueType: 'string',
    defaultValue: DEFAULT_TERMINAL_RIGHT_CLICK_ACTION,
    nameI18nKey: 'settings.items.terminalRightClickAction.title',
    descriptionI18nKey: 'settings.items.terminalRightClickAction.description',
    optionI18nNamespace: 'terminalRightClickAction',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.rightClick.action',
    commandActionId: 'settings.terminal.runtime.rightClick.action.set',
    searchTerms: ['terminal', 'right click', 'context menu', 'paste', 'copy selection'],
    options: TERMINAL_RIGHT_CLICK_ACTION_OPTIONS.map((value) => ({ value })),
  },
  {
    key: 'terminalRightClickSelectsWord',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.terminalRightClickSelectsWord.title',
    descriptionI18nKey: 'settings.items.terminalRightClickSelectsWord.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'switch',
    path: 'terminal.runtime.rightClick.selectsWord',
    commandActionId: 'settings.terminal.runtime.rightClick.selectsWord.toggle',
    searchTerms: ['terminal', 'right click', 'select word', 'rightClickSelectsWord'],
  },
  {
    key: 'terminalForceSelectionModifier',
    valueType: 'string',
    defaultValue: DEFAULT_TERMINAL_FORCE_SELECTION_MODIFIER,
    nameI18nKey: 'settings.items.terminalForceSelectionModifier.title',
    descriptionI18nKey: 'settings.items.terminalForceSelectionModifier.description',
    optionI18nNamespace: 'terminalForceSelectionModifier',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.mouseMode.forceSelectionModifier',
    commandActionId: 'settings.terminal.runtime.mouseMode.forceSelectionModifier.set',
    searchTerms: ['terminal', 'mouse mode', 'force selection', 'alt', 'shift', 'ctrl', 'mac option'],
    options: TERMINAL_FORCE_SELECTION_MODIFIER_OPTIONS.map((value) => ({ value })),
  },
  {
    key: 'localTerminalClipboardAccess',
    valueType: 'string',
    defaultValue: DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
    nameI18nKey: 'settings.items.localTerminalClipboardAccess.title',
    descriptionI18nKey: 'settings.items.localTerminalClipboardAccess.description',
    optionI18nNamespace: 'terminalClipboardAccess',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.localClipboardAccess',
    commandActionId: 'settings.terminal.runtime.localClipboardAccess.set',
    searchTerms: ['terminal', 'local terminal', 'clipboard', 'osc 52'],
    options: TERMINAL_CLIPBOARD_ACCESS_OPTIONS.map((value) => ({ value })),
  },
  {
    key: 'terminalContextLaunchBehavior',
    valueType: 'string',
    defaultValue: 'openDefaultLocalTerminal',
    nameI18nKey: 'settings.items.terminalContextLaunchBehavior.title',
    descriptionI18nKey: 'settings.items.terminalContextLaunchBehavior.description',
    optionI18nNamespace: 'terminalContextLaunchBehavior',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.contextLaunchBehavior',
    commandActionId: 'settings.terminal.runtime.contextLaunchBehavior.set',
    searchTerms: ['terminal', 'context menu', 'open in cosmosh', 'working directory', 'startup launch'],
    options: [{ value: 'openDefaultLocalTerminal' }, { value: 'openLocalTerminalList' }, { value: 'off' }],
  },
  {
    key: 'defaultLocalTerminalProfile',
    valueType: 'string',
    defaultValue: 'auto',
    nameI18nKey: 'settings.items.defaultLocalTerminalProfile.title',
    descriptionI18nKey: 'settings.items.defaultLocalTerminalProfile.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.defaultLocalTerminalProfile',
    commandActionId: 'settings.terminal.runtime.defaultLocalTerminalProfile.set',
    searchTerms: ['terminal', 'default profile', 'powershell', 'cmd', 'wsl'],
  },
  {
    key: 'terminalSelectionSearchEngine',
    valueType: 'string',
    defaultValue: 'google',
    nameI18nKey: 'settings.items.terminalSelectionSearchEngine.title',
    descriptionI18nKey: 'settings.items.terminalSelectionSearchEngine.description',
    optionI18nNamespace: 'searchEngine',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.search,
    control: 'select',
    path: 'ssh.search.searchEngine',
    commandActionId: 'settings.ssh.searchEngine.set',
    searchTerms: ['search engine', 'quick search', 'google', 'bing', 'duckduckgo', 'baidu'],
    options: [{ value: 'google' }, { value: 'bing' }, { value: 'duckduckgo' }, { value: 'baidu' }, { value: 'custom' }],
  },
  {
    key: 'terminalSelectionSearchUrlTemplate',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.terminalSelectionSearchUrlTemplate.title',
    descriptionI18nKey: 'settings.items.terminalSelectionSearchUrlTemplate.description',
    placeholderI18nKey: 'settings.items.terminalSelectionSearchUrlTemplate.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.search,
    control: 'input',
    path: 'ssh.search.searchUrlTemplate',
    commandActionId: 'settings.ssh.searchUrlTemplate.set',
    searchTerms: ['search url', 'template', '%s', 'browser'],
    maxLength: 1000,
  },
  {
    key: 'terminalAutoCompleteEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'auto complete', 'command suggestions'],
  },
  {
    key: 'terminalAutoCompleteHistoryEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteHistoryEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteHistoryEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.history.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.history.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'history', 'recent commands'],
  },
  {
    key: 'terminalAutoCompleteBuiltInCommandsEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteBuiltInCommandsEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteBuiltInCommandsEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.builtinCommands.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.builtinCommands.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'builtin commands', 'command spec'],
  },
  {
    key: 'terminalAutoCompletePathEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompletePathEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompletePathEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.path.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.path.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'path', 'directory', 'file'],
  },
  {
    key: 'terminalAutoCompletePasswordEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompletePasswordEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompletePasswordEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.password.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.password.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'password', 'secret fill'],
  },
  {
    key: 'terminalAutoCompleteAcceptKeys',
    valueType: 'string',
    defaultValue: 'tab',
    nameI18nKey: 'settings.items.terminalAutoCompleteAcceptKeys.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteAcceptKeys.description',
    optionI18nNamespace: 'terminalAutoCompleteAcceptKeys',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'select',
    path: 'terminal.runtime.autoComplete.acceptKeys',
    commandActionId: 'settings.terminal.runtime.autoComplete.acceptKeys.set',
    searchTerms: ['terminal', 'autocomplete', 'accept', 'shortcut', 'tab', 'enter'],
    options: [{ value: 'tab' }, { value: 'enter' }, { value: 'tabEnter' }],
  },
  {
    key: 'terminalAutoCompleteMinChars',
    valueType: 'number',
    defaultValue: 1,
    nameI18nKey: 'settings.items.terminalAutoCompleteMinChars.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteMinChars.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'input',
    path: 'terminal.runtime.autoComplete.minChars',
    commandActionId: 'settings.terminal.runtime.autoComplete.minChars.set',
    searchTerms: ['terminal', 'autocomplete', 'minimum chars', 'trigger'],
    inputMode: 'numeric',
    min: 1,
    max: 8,
  },
  {
    key: 'terminalAutoCompleteMaxItems',
    valueType: 'number',
    defaultValue: 8,
    nameI18nKey: 'settings.items.terminalAutoCompleteMaxItems.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteMaxItems.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'input',
    path: 'terminal.runtime.autoComplete.maxItems',
    commandActionId: 'settings.terminal.runtime.autoComplete.maxItems.set',
    searchTerms: ['terminal', 'autocomplete', 'max items', 'suggestions limit'],
    inputMode: 'numeric',
    min: 3,
    max: 20,
  },
  {
    key: 'terminalAutoCompleteFuzzyMatch',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteFuzzyMatch.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteFuzzyMatch.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.advanced.autoComplete.fuzzyMatch',
    commandActionId: 'settings.terminal.advanced.autoComplete.fuzzyMatch.toggle',
    searchTerms: ['terminal', 'autocomplete', 'fuzzy', 'fuzzy match'],
  },
  {
    key: 'terminalAutoCompletePromptRegex',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.terminalAutoCompletePromptRegex.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompletePromptRegex.description',
    placeholderI18nKey: 'settings.items.terminalAutoCompletePromptRegex.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'input',
    path: 'terminal.runtime.autoComplete.promptRegex',
    commandActionId: 'settings.terminal.runtime.autoComplete.promptRegex.set',
    searchTerms: ['terminal', 'autocomplete', 'prompt', 'regex', 'prompt parser'],
    maxLength: 300,
  },
  {
    key: 'terminalDrawBoldTextInBrightColors',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalDrawBoldTextInBrightColors.title',
    descriptionI18nKey: 'settings.items.terminalDrawBoldTextInBrightColors.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'switch',
    path: 'terminal.advanced.drawBoldTextInBrightColors',
    commandActionId: 'settings.terminal.advanced.drawBoldTextInBrightColors.toggle',
    searchTerms: ['terminal', 'bold', 'bright colors', 'advanced terminal'],
  },
  {
    key: 'terminalScrollSensitivity',
    valueType: 'string',
    defaultValue: '1',
    nameI18nKey: 'settings.items.terminalScrollSensitivity.title',
    descriptionI18nKey: 'settings.items.terminalScrollSensitivity.description',
    placeholderI18nKey: 'settings.items.terminalScrollSensitivity.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.scrollSensitivity',
    commandActionId: 'settings.terminal.advanced.scrollSensitivity.set',
    searchTerms: ['terminal', 'scroll sensitivity', 'advanced terminal'],
    inputMode: 'decimal',
    maxLength: 16,
  },
  {
    key: 'terminalFastScrollSensitivity',
    valueType: 'string',
    defaultValue: '5',
    nameI18nKey: 'settings.items.terminalFastScrollSensitivity.title',
    descriptionI18nKey: 'settings.items.terminalFastScrollSensitivity.description',
    placeholderI18nKey: 'settings.items.terminalFastScrollSensitivity.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.fastScrollSensitivity',
    commandActionId: 'settings.terminal.advanced.fastScrollSensitivity.set',
    searchTerms: ['terminal', 'fast scroll', 'sensitivity', 'advanced terminal'],
    inputMode: 'decimal',
    maxLength: 16,
  },
  {
    key: 'terminalMinimumContrastRatio',
    valueType: 'string',
    defaultValue: '1',
    nameI18nKey: 'settings.items.terminalMinimumContrastRatio.title',
    descriptionI18nKey: 'settings.items.terminalMinimumContrastRatio.description',
    placeholderI18nKey: 'settings.items.terminalMinimumContrastRatio.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.minimumContrastRatio',
    commandActionId: 'settings.terminal.advanced.minimumContrastRatio.set',
    searchTerms: ['terminal', 'contrast ratio', 'advanced terminal'],
    inputMode: 'decimal',
    maxLength: 16,
  },
  {
    key: 'terminalScreenReaderMode',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.terminalScreenReaderMode.title',
    descriptionI18nKey: 'settings.items.terminalScreenReaderMode.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'switch',
    path: 'terminal.advanced.screenReaderMode',
    commandActionId: 'settings.terminal.advanced.screenReaderMode.toggle',
    searchTerms: ['terminal', 'screen reader', 'accessibility', 'advanced terminal'],
  },
  {
    key: 'terminalScrollOnUserInput',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalScrollOnUserInput.title',
    descriptionI18nKey: 'settings.items.terminalScrollOnUserInput.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'switch',
    path: 'terminal.advanced.scrollOnUserInput',
    commandActionId: 'settings.terminal.advanced.scrollOnUserInput.toggle',
    searchTerms: ['terminal', 'scroll on user input', 'advanced terminal'],
  },
  {
    key: 'terminalSmoothScrollDuration',
    valueType: 'number',
    defaultValue: 0,
    nameI18nKey: 'settings.items.terminalSmoothScrollDuration.title',
    descriptionI18nKey: 'settings.items.terminalSmoothScrollDuration.description',
    placeholderI18nKey: 'settings.items.terminalSmoothScrollDuration.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.smoothScrollDuration',
    commandActionId: 'settings.terminal.advanced.smoothScrollDuration.set',
    searchTerms: ['terminal', 'smooth scroll duration', 'advanced terminal'],
    inputMode: 'numeric',
    min: 0,
    max: 2000,
  },
  {
    key: 'terminalTabStopWidth',
    valueType: 'number',
    defaultValue: 8,
    nameI18nKey: 'settings.items.terminalTabStopWidth.title',
    descriptionI18nKey: 'settings.items.terminalTabStopWidth.description',
    placeholderI18nKey: 'settings.items.terminalTabStopWidth.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.tabStopWidth',
    commandActionId: 'settings.terminal.advanced.tabStopWidth.set',
    searchTerms: ['terminal', 'tab stop width', 'advanced terminal'],
    inputMode: 'numeric',
    min: 1,
    max: 16,
  },
  {
    key: 'mcpEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.mcpEnabled.title',
    descriptionI18nKey: 'settings.items.mcpEnabled.description',
    category: SETTINGS_CATEGORIES.mcp,
    section: SETTINGS_CATEGORIES.mcp.sections.mcpAccess,
    control: 'switch',
    path: 'mcp.access.enabled',
    commandActionId: 'settings.mcp.access.enabled.toggle',
    searchTerms: ['mcp', 'model context protocol', 'agent', 'ai', 'automation', 'external access'],
  },
  {
    key: 'mcpListServersRequiresApproval',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.mcpListServersRequiresApproval.title',
    descriptionI18nKey: 'settings.items.mcpListServersRequiresApproval.description',
    category: SETTINGS_CATEGORIES.mcp,
    section: SETTINGS_CATEGORIES.mcp.sections.mcpPolicy,
    control: 'switch',
    path: 'mcp.policy.listServersRequiresApproval',
    commandActionId: 'settings.mcp.policy.listServersRequiresApproval.toggle',
    searchTerms: ['mcp', 'list servers', 'server list', 'authorization', 'approval', 'agent'],
  },
  {
    key: 'mcpCommandPolicy',
    valueType: 'string',
    defaultValue: DEFAULT_MCP_COMMAND_POLICY,
    nameI18nKey: 'settings.items.mcpCommandPolicy.title',
    descriptionI18nKey: 'settings.items.mcpCommandPolicy.description',
    optionI18nNamespace: 'mcpCommandPolicy',
    category: SETTINGS_CATEGORIES.mcp,
    section: SETTINGS_CATEGORIES.mcp.sections.mcpPolicy,
    control: 'select',
    path: 'mcp.policy.commandPolicy',
    commandActionId: 'settings.mcp.policy.commandPolicy.set',
    searchTerms: ['mcp', 'command policy', 'authorization', 'approval', 'agent commands'],
    options: MCP_COMMAND_POLICY_OPTIONS.map((value) => ({ value })),
  },
];

// ── Derived Defaults ─────────────────────────────────────────

export const DEFAULT_SETTINGS_VALUES: SettingsValues = Object.fromEntries(
  SETTINGS_REGISTRY.map((item) => [item.key, item.defaultValue]),
) as unknown as SettingsValues;

// ── Lookup Map ───────────────────────────────────────────────

export const SETTINGS_DEFINITION_MAP: ReadonlyMap<SettingKey, SettingDefinition> = new Map(
  SETTINGS_REGISTRY.map((item) => [item.key, item]),
);

// Reverse lookup: category object → category ID string.
const CATEGORY_ID_MAP = new Map<SettingsCategory, SettingsCategoryId>(
  (Object.entries(SETTINGS_CATEGORIES) as [SettingsCategoryId, SettingsCategory][]).map(([id, category]) => [
    category,
    id,
  ]),
);

// ── Helpers ──────────────────────────────────────────────────

export const resolveCategoryId = (category: SettingsCategory): SettingsCategoryId | undefined => {
  return CATEGORY_ID_MAP.get(category);
};

export const paginateSettingsByCategory = (
  settings: ReadonlyArray<SettingDefinition>,
  category: SettingsCategory,
): SettingDefinition[] => {
  return settings.filter((item) => item.category === category);
};

export const getVisibleCategories = (settings: ReadonlyArray<SettingDefinition>): SettingsCategoryId[] => {
  const presentCategories = new Set(
    settings.map((item) => resolveCategoryId(item.category)).filter((id): id is SettingsCategoryId => id !== undefined),
  );
  return SETTINGS_CATEGORY_IDS.filter((categoryId) => categoryId === 'about' || presentCategories.has(categoryId));
};
