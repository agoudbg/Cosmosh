import { normalizeSettingsValuesStrict, type SettingValidationError } from '@cosmosh/api-contract';
import { Cloud, Info, Link2, Palette, Save, Search, Settings2, Terminal, Wrench } from 'lucide-react';
import React from 'react';

import SettingsAboutSection, { type AppVersionInfo } from '../components/settings/SettingsAboutSection';
import { Button } from '../components/ui/button';
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

type SettingKey = keyof AppSettingsValues;

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
  const [localTerminalProfiles, setLocalTerminalProfiles] = React.useState<LocalTerminalProfile[]>([]);

  React.useEffect(() => {
    // Re-render translated labels when locale changes at runtime.
    return onLocaleChange(() => {
      setLocaleTick((value) => value + 1);
    });
  }, []);

  const normalizedSearch = search.trim().toLowerCase();
  const isSearchMode = normalizedSearch.length > 0;

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
                      <FormField key={item.path}>
                        <Label>{t(item.nameI18nKey)}</Label>
                        {renderControl(item)}
                        <div className={formStyles.helperText}>{t(item.descriptionI18nKey)}</div>
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
