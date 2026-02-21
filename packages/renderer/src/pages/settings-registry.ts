import type { components } from '@cosmosh/api-contract';
import type React from 'react';

export type SettingsCategoryId = 'general' | 'account-sync' | 'theme' | 'advanced' | 'about';

type SettingControlType = 'select' | 'input' | 'textarea';
type SettingValueType = 'string' | 'number' | 'boolean';

type SettingsValues = components['schemas']['SettingsValues'];

type SettingSelectOption = {
  label: string;
  value: string;
};

export type SettingsCategory = {
  id: SettingsCategoryId;
  label: string;
  searchTerms: string[];
};

export type SettingDefinition = {
  key: keyof SettingsValues;
  valueType: SettingValueType;
  defaultValue: string | number | boolean;
  title: string;
  description?: string;
  categoryId: SettingsCategoryId;
  sectionTitle: string;
  control: SettingControlType;
  path: string;
  commandActionId: string;
  searchTerms: string[];
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  options?: SettingSelectOption[];
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    searchTerms: ['general', 'language', 'locale'],
  },
  {
    id: 'account-sync',
    label: 'Account & Sync',
    searchTerms: ['account', 'sync', 'cloud'],
  },
  {
    id: 'theme',
    label: 'Theme',
    searchTerms: ['theme', 'appearance', 'dark', 'light', 'auto'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    searchTerms: ['advanced', 'ssh', 'terminal', 'rows', 'timeout'],
  },
  {
    id: 'about',
    label: 'About',
    searchTerms: ['about', 'version', 'scope'],
  },
];

export const SETTINGS_REGISTRY: SettingDefinition[] = [
  {
    key: 'language',
    valueType: 'string',
    defaultValue: 'en',
    title: 'Language',
    description: 'Controls UI language for the renderer and main process.',
    categoryId: 'general',
    sectionTitle: 'Localization',
    control: 'select',
    path: 'general.language',
    commandActionId: 'settings.general.language.set',
    searchTerms: ['language', 'locale', 'ui language', 'english', 'chinese'],
    options: [
      { label: 'English', value: 'en' },
      { label: 'Chinese (Simplified)', value: 'zh-CN' },
    ],
  },
  {
    key: 'accountSyncEnabled',
    valueType: 'boolean',
    defaultValue: false,
    title: 'Account Sync',
    description: 'Reserved for future cloud sync. Currently stores preference only.',
    categoryId: 'account-sync',
    sectionTitle: 'Synchronization',
    control: 'select',
    path: 'account.sync.enabled',
    commandActionId: 'settings.account.sync.toggle',
    searchTerms: ['sync', 'account sync', 'cloud sync'],
    options: [
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' },
    ],
  },
  {
    key: 'theme',
    valueType: 'string',
    defaultValue: 'dark',
    title: 'Theme',
    description: 'Controls application visual theme.',
    categoryId: 'theme',
    sectionTitle: 'Appearance',
    control: 'select',
    path: 'theme.mode',
    commandActionId: 'settings.theme.mode.set',
    searchTerms: ['theme', 'appearance', 'dark', 'light', 'auto'],
    options: [
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' },
      { label: 'Auto', value: 'auto' },
    ],
  },
  {
    key: 'sshMaxRows',
    valueType: 'number',
    defaultValue: 10000,
    title: 'SSH Max Rows',
    description: 'Maximum retained terminal lines for SSH sessions. Reserved for future runtime binding.',
    categoryId: 'advanced',
    sectionTitle: 'SSH Runtime',
    control: 'input',
    path: 'advanced.ssh.maxRows',
    commandActionId: 'settings.advanced.ssh.maxRows.set',
    searchTerms: ['ssh', 'max rows', 'terminal lines', 'scrollback'],
    inputMode: 'numeric',
    placeholder: '10000',
  },
  {
    key: 'sshConnectionTimeoutSec',
    valueType: 'number',
    defaultValue: 45,
    title: 'SSH Connection Timeout (sec)',
    description: 'Connection timeout used by future SSH dial pipeline.',
    categoryId: 'advanced',
    sectionTitle: 'SSH Runtime',
    control: 'input',
    path: 'advanced.ssh.connectionTimeoutSec',
    commandActionId: 'settings.advanced.ssh.timeout.set',
    searchTerms: ['ssh', 'timeout', 'connection timeout'],
    inputMode: 'numeric',
    placeholder: '45',
  },
  {
    key: 'autoSaveEnabled',
    valueType: 'boolean',
    defaultValue: true,
    title: 'Auto Save',
    description: 'When enabled, settings changes are saved automatically and the save button is hidden.',
    categoryId: 'advanced',
    sectionTitle: 'Editor Defaults',
    control: 'select',
    path: 'advanced.editor.autoSaveEnabled',
    commandActionId: 'settings.advanced.editor.autoSave.toggle',
    searchTerms: ['auto save', 'autosave', 'save automatically'],
    options: [
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' },
    ],
  },
  {
    key: 'defaultServerNoteTemplate',
    valueType: 'string',
    defaultValue: '',
    title: 'Default Server Note Template',
    description: 'Template text for newly created server notes. Reserved for future runtime binding.',
    categoryId: 'advanced',
    sectionTitle: 'Editor Defaults',
    control: 'textarea',
    path: 'advanced.editor.defaultServerNoteTemplate',
    commandActionId: 'settings.advanced.editor.defaultServerNoteTemplate.set',
    searchTerms: ['template', 'note', 'server note', 'editor defaults'],
    placeholder: 'Example: owner=@ops env=prod',
  },
];
