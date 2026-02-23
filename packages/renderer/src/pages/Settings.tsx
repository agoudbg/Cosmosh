import { Cloud, Info, Link2, Palette, Save, Search, Settings2, Terminal, Wrench } from 'lucide-react';
import React from 'react';

import { Button } from '../components/ui/button';
import { FormField } from '../components/ui/form';
import { formStyles } from '../components/ui/form-styles';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Menubar } from '../components/ui/menubar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import {
  applyRuntimeSettings,
  type AppSettingsScope,
  type AppSettingsValues,
  DEFAULT_APP_SETTINGS_VALUES,
  emitRuntimeSettingsUpdated,
} from '../lib/app-settings';
import { getAppSettings, updateAppSettings } from '../lib/backend';
import { onLocaleChange, t } from '../lib/i18n';
import { useToast } from '../lib/toast-context';
import {
  type SettingDefinition,
  SETTINGS_CATEGORIES,
  SETTINGS_REGISTRY,
  type SettingsCategoryId,
} from './settings-registry';

type SettingsFormState = {
  language: string;
  theme: string;
  sshMaxRows: string;
  sshConnectionTimeoutSec: string;
  devToolsEnabled: string;
  autoSaveEnabled: string;
  accountSyncEnabled: string;
  defaultServerNoteTemplate: string;
  terminalSelectionBarEnabled: boolean;
  terminalTextDropMode: AppSettingsValues['terminalTextDropMode'];
  terminalSelectionSearchEngine: AppSettingsValues['terminalSelectionSearchEngine'];
  terminalSelectionSearchUrlTemplate: string;
};

type AppVersionInfo = {
  appName: string;
  version: string;
  buildVersion: string;
};

const DEFAULT_APP_VERSION_INFO: AppVersionInfo = {
  appName: 'Cosmosh',
  version: '0.0.0',
  buildVersion: '',
};

const APP_LOGO_URL = new URL('../assets/logo.svg', import.meta.url).href;

const categoryIconMap: Record<SettingsCategoryId, React.ComponentType<{ className?: string }>> = {
  general: Settings2,
  'account-sync': Cloud,
  theme: Palette,
  terminal: Terminal,
  connection: Link2,
  advanced: Wrench,
  about: Info,
};

const sectionKeyMap: Record<string, string> = {
  Localization: 'localization',
  Synchronization: 'synchronization',
  Appearance: 'appearance',
  'SSH Runtime': 'sshRuntime',
  'Editor Defaults': 'editorDefaults',
  'Terminal Selection': 'terminalSelection',
  'Orbit Bar': 'terminalSelection',
  Connection: 'connection',
  Search: 'search',
  Runtime: 'runtime',
};

const TERMINAL_SELECTION_ENGINES: ReadonlyArray<AppSettingsValues['terminalSelectionSearchEngine']> = [
  'google',
  'bing',
  'duckduckgo',
  'baidu',
  'custom',
];

const optionLabelNamespaceMap: Partial<Record<keyof SettingsFormState, string>> = {
  language: 'language',
  theme: 'theme',
  devToolsEnabled: 'boolean',
  accountSyncEnabled: 'boolean',
  terminalTextDropMode: 'terminalTextDropMode',
  terminalSelectionSearchEngine: 'searchEngine',
};

const toFormState = (values: AppSettingsValues): SettingsFormState => {
  return {
    language: values.language,
    theme: values.theme,
    sshMaxRows: String(values.sshMaxRows),
    sshConnectionTimeoutSec: String(values.sshConnectionTimeoutSec),
    devToolsEnabled: String(values.devToolsEnabled),
    autoSaveEnabled: String(values.autoSaveEnabled),
    accountSyncEnabled: String(values.accountSyncEnabled),
    defaultServerNoteTemplate: values.defaultServerNoteTemplate,
    terminalSelectionBarEnabled: values.terminalSelectionBarEnabled,
    terminalTextDropMode: values.terminalTextDropMode,
    terminalSelectionSearchEngine: values.terminalSelectionSearchEngine,
    terminalSelectionSearchUrlTemplate: values.terminalSelectionSearchUrlTemplate,
  };
};

const parseFormState = (formState: SettingsFormState): { value?: AppSettingsValues; error?: string } => {
  if (formState.language !== 'en' && formState.language !== 'zh-CN') {
    return { error: 'Language must be either English or Chinese (Simplified).' };
  }

  if (formState.theme !== 'dark' && formState.theme !== 'light' && formState.theme !== 'auto') {
    return { error: 'Theme must be Dark, Light, or Auto.' };
  }

  const sshMaxRows = Number(formState.sshMaxRows);
  if (!Number.isInteger(sshMaxRows) || sshMaxRows < 100 || sshMaxRows > 200000) {
    return { error: 'SSH Max Rows must be an integer between 100 and 200000.' };
  }

  const sshConnectionTimeoutSec = Number(formState.sshConnectionTimeoutSec);
  if (!Number.isInteger(sshConnectionTimeoutSec) || sshConnectionTimeoutSec < 5 || sshConnectionTimeoutSec > 180) {
    return { error: 'SSH Connection Timeout must be an integer between 5 and 180 seconds.' };
  }

  if (formState.devToolsEnabled !== 'true' && formState.devToolsEnabled !== 'false') {
    return { error: 'Enable DevTools value is invalid.' };
  }

  if (formState.autoSaveEnabled !== 'true' && formState.autoSaveEnabled !== 'false') {
    return { error: 'Auto Save value is invalid.' };
  }

  if (formState.accountSyncEnabled !== 'true' && formState.accountSyncEnabled !== 'false') {
    return { error: 'Account Sync value is invalid.' };
  }

  if (formState.defaultServerNoteTemplate.length > 1000) {
    return { error: 'Default Server Note Template must be 1000 characters or fewer.' };
  }

  if (typeof formState.terminalSelectionBarEnabled !== 'boolean') {
    return { error: 'Orbit Bar value is invalid.' };
  }

  if (
    formState.terminalTextDropMode !== 'off' &&
    formState.terminalTextDropMode !== 'always' &&
    formState.terminalTextDropMode !== 'external'
  ) {
    return { error: 'Drag To Terminal value is invalid.' };
  }

  if (!TERMINAL_SELECTION_ENGINES.includes(formState.terminalSelectionSearchEngine)) {
    return { error: 'Terminal Selection Search Engine is invalid.' };
  }

  if (formState.terminalSelectionSearchUrlTemplate.length > 1000) {
    return { error: 'Terminal Selection Custom Search URL must be 1000 characters or fewer.' };
  }

  return {
    value: {
      language: formState.language,
      theme: formState.theme,
      sshMaxRows,
      sshConnectionTimeoutSec,
      devToolsEnabled: formState.devToolsEnabled === 'true',
      autoSaveEnabled: formState.autoSaveEnabled === 'true',
      accountSyncEnabled: formState.accountSyncEnabled === 'true',
      defaultServerNoteTemplate: formState.defaultServerNoteTemplate,
      terminalSelectionBarEnabled: formState.terminalSelectionBarEnabled,
      terminalTextDropMode: formState.terminalTextDropMode,
      terminalSelectionSearchEngine: formState.terminalSelectionSearchEngine,
      terminalSelectionSearchUrlTemplate: formState.terminalSelectionSearchUrlTemplate,
    },
  };
};

const matchesSearch = (item: SettingDefinition, categoryLabel: string, query: string): boolean => {
  const haystack = [
    item.title,
    item.description ?? '',
    item.sectionTitle,
    item.path,
    categoryLabel,
    ...item.searchTerms,
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
};

const resolveLocalizedOptionLabel = (itemKey: string, value: string): string => {
  const optionNamespace = optionLabelNamespaceMap[itemKey as keyof SettingsFormState];
  if (optionNamespace) {
    return t(`settings.options.${optionNamespace}.${value}`);
  }

  return value;
};

const Settings: React.FC<{ initialCategoryId?: string }> = ({ initialCategoryId }) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const [, setLocaleTick] = React.useState<number>(0);
  const [activeCategoryId, setActiveCategoryId] = React.useState<SettingsCategoryId>(() => {
    return initialCategoryId === 'about' ? 'about' : 'general';
  });
  const [search, setSearch] = React.useState<string>('');
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [isSaving, setIsSaving] = React.useState<boolean>(false);
  const [scope, setScope] = React.useState<AppSettingsScope>({ deviceId: 'local-device' });
  const [formState, setFormState] = React.useState<SettingsFormState>(toFormState(DEFAULT_APP_SETTINGS_VALUES));
  const [savedFormState, setSavedFormState] = React.useState<SettingsFormState>(
    toFormState(DEFAULT_APP_SETTINGS_VALUES),
  );
  const [appVersionInfo, setAppVersionInfo] = React.useState<AppVersionInfo>(DEFAULT_APP_VERSION_INFO);
  const [aboutIconLoadFailed, setAboutIconLoadFailed] = React.useState<boolean>(false);

  React.useEffect(() => {
    // Re-render translated labels when locale changes at runtime.
    return onLocaleChange(() => {
      setLocaleTick((value) => value + 1);
    });
  }, []);

  const normalizedSearch = search.trim().toLowerCase();
  const isSearchMode = normalizedSearch.length > 0;

  const visibleSettings = React.useMemo(() => {
    const resolveCategoryLabel = (categoryId: SettingsCategoryId): string => {
      return t(`settings.categories.${categoryId}`);
    };

    if (!normalizedSearch) {
      return SETTINGS_REGISTRY;
    }

    return SETTINGS_REGISTRY.filter((item) => {
      const categoryLabel = resolveCategoryLabel(item.categoryId);
      return matchesSearch(item, categoryLabel, normalizedSearch);
    });
  }, [normalizedSearch]);

  const visibleCategoryIds = React.useMemo(() => {
    return new Set(visibleSettings.map((item) => item.categoryId));
  }, [visibleSettings]);

  React.useEffect(() => {
    // Keep selected category valid when search filtering hides it.
    if (activeCategoryId === 'about' || isSearchMode) {
      return;
    }

    if (visibleCategoryIds.size === 0) {
      return;
    }

    if (!visibleCategoryIds.has(activeCategoryId)) {
      const firstVisible = SETTINGS_CATEGORIES.find((category) => visibleCategoryIds.has(category.id));
      if (firstVisible) {
        setActiveCategoryId(firstVisible.id);
      }
    }
  }, [activeCategoryId, isSearchMode, visibleCategoryIds]);

  React.useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      setIsLoading(true);

      try {
        const response = await getAppSettings();
        if (cancelled) {
          return;
        }

        const nextFormState = toFormState(response.data.item.values);

        setScope(response.data.item.scope);
        setFormState(nextFormState);
        setSavedFormState(nextFormState);
      } catch (error: unknown) {
        if (!cancelled) {
          notifyError(error instanceof Error ? error.message : 'Failed to load settings.');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [notifyError]);

  React.useEffect(() => {
    let cancelled = false;

    const loadAppVersionInfo = async () => {
      try {
        const response = await window.electron?.getAppVersionInfo?.();
        if (cancelled || !response) {
          return;
        }

        setAppVersionInfo(response);
      } catch {
        if (!cancelled) {
          setAppVersionInfo(DEFAULT_APP_VERSION_INFO);
        }
      }
    };

    void loadAppVersionInfo();

    return () => {
      cancelled = true;
    };
  }, []);

  const hasChanges = React.useMemo(() => {
    return JSON.stringify(formState) !== JSON.stringify(savedFormState);
  }, [formState, savedFormState]);

  const isAutoSaveEnabled = formState.autoSaveEnabled === 'true';

  const activeCategory = React.useMemo(() => {
    return SETTINGS_CATEGORIES.find((item) => item.id === activeCategoryId) ?? SETTINGS_CATEGORIES[0];
  }, [activeCategoryId]);

  const categorySettings = React.useMemo(() => {
    if (activeCategoryId === 'about') {
      return [] as SettingDefinition[];
    }

    return visibleSettings.filter((item) => item.categoryId === activeCategoryId);
  }, [activeCategoryId, visibleSettings]);

  const renderedSettings = React.useMemo(() => {
    const candidate = isSearchMode ? visibleSettings : categorySettings;

    return candidate.filter((item) => {
      if (item.key === 'terminalSelectionSearchUrlTemplate') {
        return formState.terminalSelectionSearchEngine === 'custom';
      }

      return true;
    });
  }, [categorySettings, formState.terminalSelectionSearchEngine, isSearchMode, visibleSettings]);

  const sections = React.useMemo(() => {
    const grouped = new Map<string, SettingDefinition[]>();

    const resolveSectionTitle = (item: SettingDefinition): string => {
      const sectionLabel = t(`settings.sections.${sectionKeyMap[item.sectionTitle] ?? 'runtime'}`);

      if (!isSearchMode) {
        return sectionLabel;
      }

      const category = SETTINGS_CATEGORIES.find((value) => value.id === item.categoryId);
      const categoryLabel = t(`settings.categories.${category?.id ?? item.categoryId}`);
      return `${categoryLabel} / ${sectionLabel}`;
    };

    renderedSettings.forEach((item) => {
      const sectionTitle = resolveSectionTitle(item);
      const current = grouped.get(sectionTitle) ?? [];
      current.push(item);
      grouped.set(sectionTitle, current);
    });

    return [...grouped.entries()].map(([title, items]) => ({ title, items }));
  }, [isSearchMode, renderedSettings]);

  const updateField = React.useCallback(<K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => {
    setFormState((previous) => ({
      ...previous,
      [key]: value,
    }));
  }, []);

  const persistSettings = React.useCallback(
    async (targetFormState: SettingsFormState, options?: { silent?: boolean }): Promise<boolean> => {
      const parsed = parseFormState(targetFormState);
      if (!parsed.value) {
        if (!options?.silent) {
          notifyWarning(parsed.error ?? 'Settings are invalid.');
        }

        return false;
      }

      setIsSaving(true);

      try {
        const response = await updateAppSettings({
          scope,
          values: parsed.value,
        });

        const nextFormState = toFormState(response.data.item.values);
        setScope(response.data.item.scope);
        setFormState(nextFormState);
        setSavedFormState(nextFormState);
        await applyRuntimeSettings(response.data.item.values);
        emitRuntimeSettingsUpdated(response.data.item.values);
        if (!options?.silent) {
          notifySuccess(t('settings.saveSuccess'));
        }

        return true;
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('settings.saveFailed'));
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [notifyError, notifySuccess, notifyWarning, scope],
  );

  const saveSettings = React.useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      return persistSettings(formState, options);
    },
    [formState, persistSettings],
  );

  React.useEffect(() => {
    // Auto-save only when enabled and when current values are valid.
    if (isLoading || isSaving || !isAutoSaveEnabled || !hasChanges) {
      return;
    }

    const parsed = parseFormState(formState);
    if (!parsed.value) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void persistSettings(formState, { silent: true });
    }, 500);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [formState, hasChanges, isAutoSaveEnabled, isLoading, isSaving, persistSettings]);

  const renderControl = React.useCallback(
    (item: SettingDefinition): React.ReactNode => {
      if (item.key === 'autoSaveEnabled') {
        return (
          <div className="flex items-center gap-2.5 px-2.5">
            <Switch
              checked={formState.autoSaveEnabled === 'true'}
              onCheckedChange={(checkedState) => {
                const nextFormState: SettingsFormState = {
                  ...formState,
                  autoSaveEnabled: String(checkedState),
                };
                setFormState(nextFormState);
                void persistSettings(nextFormState, { silent: true });
              }}
            />
            <span className="text-sm text-form-text-muted">
              {formState.autoSaveEnabled === 'true' ? t('settings.enabled') : t('settings.disabled')}
            </span>
          </div>
        );
      }

      if (item.control === 'select') {
        const value = formState[item.key] as string;
        return (
          <Select
            value={value}
            onValueChange={(nextValue) => {
              updateField(item.key as keyof SettingsFormState, nextValue);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(item.options ?? []).map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                >
                  {resolveLocalizedOptionLabel(item.key, option.value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }

      if (item.control === 'switch') {
        const value = Boolean(formState[item.key]);
        return (
          <div className="flex items-center gap-2.5 px-2.5">
            <Switch
              checked={value}
              onCheckedChange={(checkedState) => {
                updateField(
                  item.key as keyof SettingsFormState,
                  checkedState as SettingsFormState[keyof SettingsFormState],
                );
              }}
            />
            <span className="text-sm text-form-text-muted">
              {value ? t('settings.enabled') : t('settings.disabled')}
            </span>
          </div>
        );
      }

      if (item.control === 'textarea') {
        return (
          <Textarea
            rows={4}
            value={String(formState[item.key])}
            placeholder={t(`settings.items.${item.key}.placeholder`)}
            onChange={(event) => {
              updateField(item.key as keyof SettingsFormState, event.target.value);
            }}
          />
        );
      }

      return (
        <Input
          value={String(formState[item.key])}
          inputMode={item.inputMode}
          placeholder={t(`settings.items.${item.key}.placeholder`)}
          onChange={(event) => {
            updateField(item.key as keyof SettingsFormState, event.target.value);
          }}
        />
      );
    },
    [formState, persistSettings, updateField],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 py-2">
      <div className="flex min-h-0 flex-1 gap-3.5">
        <aside className="flex h-full w-[250px] shrink-0 flex-col">
          <div className="pb-3">
            <Menubar className="w-full">
              <div className="relative w-full">
                <Input
                  value={search}
                  placeholder={t('settings.searchPlaceholder')}
                  className="pr-9"
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
              </div>
            </Menubar>
          </div>

          <div className="min-h-0 flex-1 overflow-auto pb-2">
            <div className="">
              {SETTINGS_CATEGORIES.map((category) => {
                const Icon = categoryIconMap[category.id];

                return (
                  <Button
                    key={category.id}
                    variant={activeCategoryId === category.id ? 'default' : 'ghost'}
                    className="w-full !justify-start"
                    onClick={() => setActiveCategoryId(category.id)}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{t(`settings.categories.${category.id}`)}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </aside>

        <div className="w-px shrink-0 bg-home-divider" />

        <main className="flex min-w-0 flex-1 flex-col pl-2">
          <div className="shrink-0 bg-bg pb-2">
            <div className="flex items-start justify-between gap-4 pb-1">
              <div className="grid gap-1">
                <h1 className="text-home-text ps-2 text-[24px] font-semibold">
                  {isSearchMode ? t('settings.searchResults') : t(`settings.categories.${activeCategory.id}`)}
                </h1>
                {isSearchMode ? (
                  <p className="text-sm text-home-text-subtle">{`${t('settings.query')}: "${search.trim()}"`}</p>
                ) : null}
              </div>

              {!isAutoSaveEnabled ? (
                <Button
                  disabled={isLoading || isSaving || !hasChanges}
                  onClick={() => {
                    void saveSettings();
                  }}
                >
                  <Save className="h-4 w-4" />
                  {isSaving ? t('settings.saving') : t('settings.saveChanges')}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {isLoading ? <div className="px-2 text-sm text-home-text-subtle">{t('settings.loading')}</div> : null}

            {!isLoading && activeCategoryId === 'about' && !isSearchMode ? (
              <div className="grid gap-4 pb-4">
                <section className="mx-auto grid w-full max-w-[600px] gap-3">
                  <div className="flex flex-col items-center gap-3 px-2 py-1">
                    <div className="bg-elevated flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border border-home-divider">
                      {!aboutIconLoadFailed ? (
                        <img
                          src={APP_LOGO_URL}
                          alt={t('settings.about.appIconAlt')}
                          className="h-full w-full object-cover"
                          onDragStart={(e) => {
                            e.preventDefault();
                          }}
                          onError={() => setAboutIconLoadFailed(true)}
                        />
                      ) : (
                        <Info className="h-10 w-10 text-home-text-subtle" />
                      )}
                    </div>
                    <h2 className="text-home-text text-2xl font-semibold">{appVersionInfo.appName}</h2>
                    <div className="grid justify-items-center gap-1">
                      <p className="select-text text-sm text-home-text-subtle">
                        {t('settings.about.versionDisplay', {
                          version: appVersionInfo.version,
                          build: appVersionInfo.buildVersion || '0',
                        })}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-2 px-2.5 pt-5">
                    <div className="flex items-center justify-between py-1 text-sm">
                      <span className="text-home-text-subtle">{t('settings.about.openSourceLicense')}</span>
                      <span className="text-home-text select-text">GPL-3.0-only</span>
                    </div>
                    <div className="flex items-center justify-between py-1 text-sm">
                      <span className="text-home-text-subtle">{t('settings.about.github')}</span>
                      <button
                        type="button"
                        className="text-home-text select-text underline hover:text-home-text-subtle"
                        onClick={() => {
                          void window.electron
                            ?.openExternalUrl?.('https://github.com/agoudbg/cosmosh')
                            .then((opened) => {
                              if (!opened) {
                                notifyWarning(t('settings.about.openGithubFailed'));
                              }
                            });
                        }}
                      >
                        https://github.com/agoudbg/cosmosh
                      </button>
                    </div>
                    <div className="flex items-center justify-between py-1 text-sm">
                      <span className="text-home-text-subtle">{t('settings.about.website')}</span>
                      <button
                        type="button"
                        className="text-home-text select-text underline hover:text-home-text-subtle"
                        onClick={() => {
                          void window.electron?.openExternalUrl?.('https://cosmosh.pages.dev').then((opened) => {
                            if (!opened) {
                              notifyWarning(t('settings.about.openWebsiteFailed'));
                            }
                          });
                        }}
                      >
                        https://cosmosh.pages.dev
                      </button>
                    </div>
                  </div>

                  <p className="px-2.5 text-xs text-home-text-subtle">{t('settings.about.copyright')}</p>
                </section>
              </div>
            ) : null}

            {!isLoading && activeCategoryId !== 'about' && sections.length === 0 ? (
              <div className="px-2 text-sm text-home-text-subtle">{t('settings.noMatches')}</div>
            ) : null}

            {!isLoading && (activeCategoryId !== 'about' || isSearchMode) && sections.length > 0 ? (
              <div className="grid gap-5 pb-4">
                {sections.map((section) => (
                  <section
                    key={section.title}
                    className="grid gap-3"
                  >
                    <div className="px-2 pb-1 text-[15px] font-medium text-home-text-subtle">{section.title}</div>
                    {section.items.map((item) => (
                      <FormField key={item.path}>
                        <Label>{t(`settings.items.${item.key}.title`)}</Label>
                        {renderControl(item)}
                        <div className={formStyles.helperText}>{t(`settings.items.${item.key}.description`)}</div>
                      </FormField>
                    ))}
                  </section>
                ))}
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
};

export default Settings;
