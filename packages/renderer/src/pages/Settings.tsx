import { normalizeSettingsValuesStrict, type SettingValidationError } from '@cosmosh/api-contract';
import {
  Cloud,
  Info,
  Link2,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  SettingsIcon,
  Terminal,
  Wrench,
} from 'lucide-react';
import React from 'react';

import SettingsAboutSection, { type AppVersionInfo } from '../components/settings/SettingsAboutSection';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { FormField } from '../components/ui/form';
import { formStyles } from '../components/ui/form-styles';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Menubar } from '../components/ui/menubar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import type { LocalTerminalProfile } from '../lib/api/transport';
import { type AppSettingsScope, type AppSettingsValues, DEFAULT_APP_SETTINGS_VALUES } from '../lib/app-settings';
import { getAppSettings, listLocalTerminalProfiles, updateAppSettings } from '../lib/backend';
import { onLocaleChange, t } from '../lib/i18n';
import { updateSettingsStoreValues } from '../lib/settings-store';
import { useToast } from '../lib/toast-context';
import {
  getVisibleCategories,
  paginateSettingsByCategory,
  resolveCategoryId,
  type SettingDefinition,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_IDS,
  SETTINGS_REGISTRY,
  type SettingsCategoryId,
} from './settings-registry';

type SettingsFormState = {
  [K in keyof AppSettingsValues]: string | boolean;
};

const AUTOCOMPLETE_DEPENDENT_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'terminalAutoCompleteHistoryEnabled',
  'terminalAutoCompleteBuiltInCommandsEnabled',
  'terminalAutoCompletePathEnabled',
  'terminalAutoCompletePasswordEnabled',
  'terminalAutoCompleteMinChars',
  'terminalAutoCompleteMaxItems',
  'terminalAutoCompleteFuzzyMatch',
]);

type SettingKey = keyof AppSettingsValues;

type DatabaseSecurityInfo = {
  runtimeMode: 'development' | 'production';
  resolverMode: 'development-fixed-key' | 'safe-storage' | 'master-password-fallback';
  safeStorageAvailable: boolean;
  databasePath: string;
  securityConfigPath: string;
  hasEncryptedDbMasterKey: boolean;
  hasMasterPasswordHash: boolean;
  hasMasterPasswordSalt: boolean;
  hasMasterPasswordEnv: boolean;
  fallbackReady: boolean;
};

const DEFAULT_APP_VERSION_INFO: AppVersionInfo = {
  appName: 'Cosmosh',
  version: '0.0.0',
  buildVersion: '',
  buildTime: '',
  commit: '',
  electron: '',
  chromium: '',
  node: '',
  v8: '',
  os: '',
};

const DEFAULT_DATABASE_SECURITY_INFO: DatabaseSecurityInfo = {
  runtimeMode: 'development',
  resolverMode: 'development-fixed-key',
  safeStorageAvailable: false,
  databasePath: '',
  securityConfigPath: '',
  hasEncryptedDbMasterKey: false,
  hasMasterPasswordHash: false,
  hasMasterPasswordSalt: false,
  hasMasterPasswordEnv: false,
  fallbackReady: false,
};

const categoryIconMap: Record<SettingsCategoryId, React.ComponentType<{ className?: string }>> = {
  general: Settings2,
  'account-sync': Cloud,
  theme: Palette,
  terminal: Terminal,
  connection: Link2,
  advanced: Wrench,
  about: Info,
};

const toFormState = (values: AppSettingsValues): SettingsFormState => {
  const formState = {} as SettingsFormState;

  SETTINGS_REGISTRY.forEach((item) => {
    const raw = values[item.key];
    formState[item.key] = item.control === 'switch' ? Boolean(raw) : String(raw);
  });

  return formState;
};

const toValidationCandidateValue = (item: SettingDefinition, draftValue: string | boolean): unknown => {
  if (item.control === 'switch') {
    return Boolean(draftValue);
  }

  if (item.valueType === 'number') {
    return Number(draftValue);
  }

  if (item.valueType === 'boolean') {
    if (draftValue === 'true') {
      return true;
    }

    if (draftValue === 'false') {
      return false;
    }

    return draftValue;
  }

  return String(draftValue);
};

const formatValidationError = (error: SettingValidationError): string => {
  try {
    // Resolve the setting name if the error references one via nameI18nKey.
    const params: Record<string, string | number> = { ...error.params };
    if (typeof params.nameI18nKey === 'string') {
      params.name = t(params.nameI18nKey as string);
    }

    return t(error.i18nKey, params);
  } catch {
    return error.fallbackMessage;
  }
};

const parseFormState = (formState: SettingsFormState): { value?: AppSettingsValues; error?: string } => {
  const candidate = {} as Record<SettingKey, unknown>;

  for (const item of SETTINGS_REGISTRY) {
    candidate[item.key] = toValidationCandidateValue(item, formState[item.key]);
  }

  const normalized = normalizeSettingsValuesStrict(candidate);
  if (!normalized.value) {
    return { error: normalized.error ? formatValidationError(normalized.error) : 'Settings are invalid.' };
  }

  return { value: normalized.value };
};

const matchesSearch = (
  item: SettingDefinition,
  categoryLabel: string,
  descriptionText: string,
  query: string,
): boolean => {
  const haystack = [
    t(item.nameI18nKey),
    descriptionText,
    t(item.section.labelI18nKey),
    item.path,
    categoryLabel,
    ...item.searchTerms,
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
};

const resolveLocalizedOptionLabel = (item: SettingDefinition, value: string): string => {
  const optionNamespace = item.optionI18nNamespace;
  if (optionNamespace) {
    return t(`settings.options.${optionNamespace}.${value}`);
  }

  return value;
};

const toDefaultFormValue = (item: SettingDefinition): string | boolean => {
  if (item.control === 'switch') {
    return Boolean(item.defaultValue);
  }

  return String(item.defaultValue);
};

const Settings: React.FC<{ initialCategoryId?: string; onOpenSettingInEditor?: (settingKey: SettingKey) => void }> = ({
  initialCategoryId,
  onOpenSettingInEditor,
}) => {
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
  const [databaseSecurityInfo, setDatabaseSecurityInfo] =
    React.useState<DatabaseSecurityInfo>(DEFAULT_DATABASE_SECURITY_INFO);
  const [isDatabaseSecurityInfoLoading, setIsDatabaseSecurityInfoLoading] = React.useState<boolean>(false);
  const [isDatabaseSecurityDialogOpen, setIsDatabaseSecurityDialogOpen] = React.useState<boolean>(false);
  const [localTerminalProfiles, setLocalTerminalProfiles] = React.useState<LocalTerminalProfile[]>([]);

  React.useEffect(() => {
    // Re-render translated labels when locale changes at runtime.
    return onLocaleChange(() => {
      setLocaleTick((value) => value + 1);
    });
  }, []);

  const normalizedSearch = search.trim().toLowerCase();
  const isSearchMode = normalizedSearch.length > 0;

  const loadDatabaseSecurityInfo = React.useCallback(async () => {
    setIsDatabaseSecurityInfoLoading(true);

    try {
      const response = await window.electron?.getDatabaseSecurityInfo?.();

      if (response) {
        setDatabaseSecurityInfo(response);
      }
    } catch {
      setDatabaseSecurityInfo(DEFAULT_DATABASE_SECURITY_INFO);
    } finally {
      setIsDatabaseSecurityInfoLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (activeCategoryId !== 'advanced' || isSearchMode) {
      return;
    }

    void loadDatabaseSecurityInfo();
  }, [activeCategoryId, isSearchMode, loadDatabaseSecurityInfo]);

  const visibleSettings = React.useMemo(() => {
    const resolveCategoryLabel = (category: SettingDefinition['category']): string => {
      return t(category.labelI18nKey);
    };

    if (!normalizedSearch) {
      return SETTINGS_REGISTRY;
    }

    return SETTINGS_REGISTRY.filter((item) => {
      const categoryLabel = resolveCategoryLabel(item.category);
      const descriptionText = t(item.descriptionI18nKey);
      return matchesSearch(item, categoryLabel, descriptionText, normalizedSearch);
    });
  }, [normalizedSearch]);

  const visibleCategoryIds = React.useMemo(() => {
    return getVisibleCategories(visibleSettings);
  }, [visibleSettings]);

  React.useEffect(() => {
    // Keep selected category valid when search filtering hides it.
    if (activeCategoryId === 'about' || isSearchMode) {
      return;
    }

    if (visibleCategoryIds.length === 0) {
      return;
    }

    if (!visibleCategoryIds.includes(activeCategoryId)) {
      const firstVisible = SETTINGS_CATEGORY_IDS.find((id) => visibleCategoryIds.includes(id));
      if (firstVisible) {
        setActiveCategoryId(firstVisible);
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

    const loadLocalTerminalProfiles = async () => {
      try {
        const response = await listLocalTerminalProfiles();
        if (cancelled) {
          return;
        }

        setLocalTerminalProfiles(response.data.items);
      } catch {
        if (!cancelled) {
          setLocalTerminalProfiles([]);
        }
      }
    };

    void loadLocalTerminalProfiles();

    return () => {
      cancelled = true;
    };
  }, []);

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

  const formatBooleanLabel = React.useCallback((value: boolean): string => {
    return value ? t('settings.enabled') : t('settings.disabled');
  }, []);

  const resolverModeLabel = React.useMemo(() => {
    return t(`settings.databaseSecurity.resolverMode.${databaseSecurityInfo.resolverMode}`);
  }, [databaseSecurityInfo.resolverMode]);

  const runtimeModeLabel = React.useMemo(() => {
    return t(`settings.databaseSecurity.runtimeMode.${databaseSecurityInfo.runtimeMode}`);
  }, [databaseSecurityInfo.runtimeMode]);

  const activeCategory = React.useMemo(() => {
    return SETTINGS_CATEGORIES[activeCategoryId];
  }, [activeCategoryId]);

  const categorySettings = React.useMemo(() => {
    if (activeCategoryId === 'about') {
      return [] as SettingDefinition[];
    }

    return paginateSettingsByCategory(visibleSettings, SETTINGS_CATEGORIES[activeCategoryId]);
  }, [activeCategoryId, visibleSettings]);

  const renderedSettings = React.useMemo(() => {
    const candidate = isSearchMode ? visibleSettings : categorySettings;
    const isTerminalAutocompleteEnabled = formState.terminalAutoCompleteEnabled === true;

    return candidate.filter((item) => {
      if (AUTOCOMPLETE_DEPENDENT_KEYS.has(item.key) && !isTerminalAutocompleteEnabled) {
        return false;
      }

      if (item.key === 'terminalSelectionSearchUrlTemplate') {
        return formState.terminalSelectionSearchEngine === 'custom';
      }

      return true;
    });
  }, [
    categorySettings,
    formState.terminalAutoCompleteEnabled,
    formState.terminalSelectionSearchEngine,
    isSearchMode,
    visibleSettings,
  ]);

  const sections = React.useMemo(() => {
    const grouped = new Map<string, SettingDefinition[]>();

    const resolveSectionTitle = (item: SettingDefinition): string => {
      const sectionLabel = t(item.section.labelI18nKey);

      if (!isSearchMode) {
        return sectionLabel;
      }

      const categoryId = resolveCategoryId(item.category);
      const categoryLabel = t(item.category.labelI18nKey);
      return categoryId ? `${categoryLabel} / ${sectionLabel}` : sectionLabel;
    };

    renderedSettings.forEach((item) => {
      const sectionTitle = resolveSectionTitle(item);
      const current = grouped.get(sectionTitle) ?? [];
      current.push(item);
      grouped.set(sectionTitle, current);
    });

    return [...grouped.entries()].map(([title, items]) => ({ title, items }));
  }, [isSearchMode, renderedSettings]);

  const updateField = React.useCallback(<K extends SettingKey>(key: K, value: SettingsFormState[K]) => {
    setFormState((previous) => ({
      ...previous,
      [key]: value,
    }));
  }, []);

  const resetSettingToDefault = React.useCallback((item: SettingDefinition) => {
    const defaultValue = toDefaultFormValue(item);
    setFormState((previous) => ({
      ...previous,
      [item.key]: defaultValue,
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
        await updateSettingsStoreValues(response.data.item.values);
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

        if (item.key === 'defaultLocalTerminalProfile') {
          const fallbackOptionValue = value.trim();
          const profileOptions = localTerminalProfiles.map((profile) => ({
            value: profile.id,
            label: `${profile.name} (${profile.id})`,
          }));
          const hasFallbackOption =
            fallbackOptionValue.length > 0 &&
            fallbackOptionValue !== 'auto' &&
            profileOptions.every((option) => option.value !== fallbackOptionValue);
          const dynamicOptions = [
            {
              value: 'auto',
              label: t('settings.options.defaultLocalTerminalProfile.auto'),
            },
            ...profileOptions,
            ...(hasFallbackOption
              ? [
                  {
                    value: fallbackOptionValue,
                    label: `${fallbackOptionValue} (${t('settings.options.defaultLocalTerminalProfile.unavailable')})`,
                  },
                ]
              : []),
          ];

          return (
            <Select
              value={value}
              onValueChange={(nextValue) => {
                updateField(item.key, nextValue);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dynamicOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        }

        return (
          <Select
            value={value}
            onValueChange={(nextValue) => {
              updateField(item.key, nextValue);
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
                  {resolveLocalizedOptionLabel(item, option.value)}
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
                updateField(item.key, checkedState as SettingsFormState[SettingKey]);
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
            placeholder={item.placeholderI18nKey ? t(item.placeholderI18nKey) : undefined}
            onChange={(event) => {
              updateField(item.key, event.target.value);
            }}
          />
        );
      }

      return (
        <Input
          value={String(formState[item.key])}
          inputMode={item.inputMode}
          placeholder={item.placeholderI18nKey ? t(item.placeholderI18nKey) : undefined}
          onChange={(event) => {
            updateField(item.key, event.target.value);
          }}
        />
      );
    },
    [formState, localTerminalProfiles, persistSettings, updateField],
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
              {SETTINGS_CATEGORY_IDS.map((categoryId) => {
                const category = SETTINGS_CATEGORIES[categoryId];
                const Icon = categoryIconMap[categoryId];

                return (
                  <Button
                    key={categoryId}
                    variant={activeCategoryId === categoryId ? 'default' : 'ghost'}
                    className="w-full !justify-start"
                    onClick={() => setActiveCategoryId(categoryId)}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{t(category.labelI18nKey)}</span>
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
                  {isSearchMode ? t('settings.searchResults') : t(activeCategory.labelI18nKey)}
                </h1>
                {isSearchMode ? (
                  <p className="text-sm text-home-text-subtle">{`${t('settings.query')}: "${search.trim()}"`}</p>
                ) : null}
              </div>

              {!isAutoSaveEnabled ? (
                <Menubar>
                  <Button
                    disabled={isLoading || isSaving || !hasChanges}
                    onClick={() => {
                      void saveSettings();
                    }}
                  >
                    <Save className="h-4 w-4" />
                    {isSaving ? t('settings.saving') : t('settings.saveChanges')}
                  </Button>
                </Menubar>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {isLoading ? <div className="px-2 text-sm text-home-text-subtle">{t('settings.loading')}</div> : null}

            {!isLoading && activeCategoryId === 'about' && !isSearchMode ? (
              <SettingsAboutSection
                appVersionInfo={appVersionInfo}
                onOpenFailed={(i18nKey) => {
                  notifyWarning(t(i18nKey));
                }}
              />
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
                      <FormField
                        key={item.path}
                        className="group/setting"
                      >
                        <div className="flex items-center">
                          <Label>{t(item.nameI18nKey)}</Label>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label={t('settings.itemActions.openMenu')}
                                className="flex h-5 w-5 items-center justify-center rounded-md text-home-text-subtle opacity-0 outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-outline group-focus-within/setting:opacity-100 group-hover/setting:opacity-100"
                              >
                                <SettingsIcon className="h-3.5 w-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              <DropdownMenuItem
                                icon={RotateCcw}
                                onSelect={() => resetSettingToDefault(item)}
                              >
                                {t('settings.itemActions.resetToDefault')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                icon={Settings2}
                                onSelect={() => onOpenSettingInEditor?.(item.key)}
                              >
                                {t('settings.itemActions.editInSettingsEditor')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        {renderControl(item)}
                        <div className={formStyles.helperText}>{t(item.descriptionI18nKey)}</div>
                      </FormField>
                    ))}
                  </section>
                ))}
              </div>
            ) : null}

            {!isLoading && activeCategoryId === 'advanced' && !isSearchMode ? (
              <div className="flex justify-end pb-4 pr-1">
                <button
                  type="button"
                  className="text-home-text text-sm underline hover:text-home-text-subtle"
                  onClick={() => {
                    setIsDatabaseSecurityDialogOpen(true);
                    void loadDatabaseSecurityInfo();
                  }}
                >
                  {t('settings.databaseSecurity.openDialog')}
                </button>
              </div>
            ) : null}
          </div>
        </main>
      </div>

      <Dialog
        open={isDatabaseSecurityDialogOpen}
        onOpenChange={setIsDatabaseSecurityDialogOpen}
      >
        <DialogContent className="max-w-[760px]">
          <DialogHeader>
            <DialogTitle>{t('settings.databaseSecurity.title')}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-2 rounded-md border border-home-divider p-3 text-sm">
            <p className="pb-1 text-home-text-subtle">{t('settings.databaseSecurity.description')}</p>

            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">{t('settings.databaseSecurity.fields.runtimeMode')}</span>
              <span className="text-home-text select-text break-all">{runtimeModeLabel}</span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">{t('settings.databaseSecurity.fields.resolverMode')}</span>
              <span className="text-home-text select-text break-all">{resolverModeLabel}</span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">
                {t('settings.databaseSecurity.fields.safeStorageAvailable')}
              </span>
              <span className="text-home-text select-text break-all">
                {formatBooleanLabel(databaseSecurityInfo.safeStorageAvailable)}
              </span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">
                {t('settings.databaseSecurity.fields.hasEncryptedDbMasterKey')}
              </span>
              <span className="text-home-text select-text break-all">
                {formatBooleanLabel(databaseSecurityInfo.hasEncryptedDbMasterKey)}
              </span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">
                {t('settings.databaseSecurity.fields.hasMasterPasswordHash')}
              </span>
              <span className="text-home-text select-text break-all">
                {formatBooleanLabel(databaseSecurityInfo.hasMasterPasswordHash)}
              </span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">
                {t('settings.databaseSecurity.fields.hasMasterPasswordSalt')}
              </span>
              <span className="text-home-text select-text break-all">
                {formatBooleanLabel(databaseSecurityInfo.hasMasterPasswordSalt)}
              </span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">
                {t('settings.databaseSecurity.fields.hasMasterPasswordEnv')}
              </span>
              <span className="text-home-text select-text break-all">
                {formatBooleanLabel(databaseSecurityInfo.hasMasterPasswordEnv)}
              </span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">{t('settings.databaseSecurity.fields.fallbackReady')}</span>
              <span className="text-home-text select-text break-all">
                {formatBooleanLabel(databaseSecurityInfo.fallbackReady)}
              </span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">{t('settings.databaseSecurity.fields.securityConfigPath')}</span>
              <span className="text-home-text select-text break-all">{databaseSecurityInfo.securityConfigPath}</span>
            </div>
            <div className="grid grid-cols-[220px,1fr] items-start gap-3">
              <span className="text-home-text-subtle">{t('settings.databaseSecurity.fields.databasePath')}</span>
              <span className="text-home-text select-text break-all">{databaseSecurityInfo.databasePath}</span>
            </div>
          </div>

          <DialogFooter>
            <DialogSecondaryButton
              disabled={isDatabaseSecurityInfoLoading}
              onClick={() => {
                void loadDatabaseSecurityInfo();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {isDatabaseSecurityInfoLoading
                ? t('settings.databaseSecurity.refreshing')
                : t('settings.databaseSecurity.refresh')}
            </DialogSecondaryButton>
            <DialogPrimaryButton onClick={() => setIsDatabaseSecurityDialogOpen(false)}>
              {t('settings.databaseSecurity.close')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Settings;
