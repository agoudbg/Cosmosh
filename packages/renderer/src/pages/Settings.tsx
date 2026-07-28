import { normalizeSettingsValuesStrict, type SettingValidationError } from '@cosmosh/api-contract';
import {
  Bot,
  Cloud,
  Folder,
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

import SplitWorkbenchLayout, { SplitWorkbenchMainPanel } from '../components/layout/SplitWorkbenchLayout';
import SettingsAboutSection, { type AppVersionInfo } from '../components/settings/SettingsAboutSection';
import SettingsMcpSection from '../components/settings/SettingsMcpSection';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

type SettingsFormValue = string | boolean | AppSettingsValues[keyof AppSettingsValues];

type SettingsFormState = {
  [K in keyof AppSettingsValues]: SettingsFormValue;
};

const AUTOCOMPLETE_DEPENDENT_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'terminalAutoCompleteHistoryEnabled',
  'terminalAutoCompleteBuiltInCommandsEnabled',
  'terminalAutoCompletePathEnabled',
  'terminalAutoCompletePasswordEnabled',
  'terminalAutoCompleteMinChars',
  'terminalAutoCompleteMaxItems',
  'terminalAutoCompleteFuzzyMatch',
  'terminalAutoCompletePromptRegex',
]);

const FALLBACK_TIME_ZONE_OPTIONS = [
  'UTC',
  'Africa/Cairo',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/New_York',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/London',
] as const;

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

/**
 * Clones a JSON setting value so form state never mutates registry defaults.
 *
 * @param value Structured JSON setting value.
 * @returns Detached JSON-compatible value copy.
 */
function cloneJsonSettingValue<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

const categoryIconMap: Record<SettingsCategoryId, React.ComponentType<{ className?: string }>> = {
  general: Settings2,
  'account-sync': Cloud,
  theme: Palette,
  terminal: Terminal,
  connection: Link2,
  sftp: Folder,
  mcp: Bot,
  advanced: Wrench,
  about: Info,
};

const toFormState = (values: AppSettingsValues): SettingsFormState => {
  const formState = {} as SettingsFormState;

  SETTINGS_REGISTRY.forEach((item) => {
    const raw = values[item.key];
    if (item.control === 'json') {
      formState[item.key] = cloneJsonSettingValue(raw);
      return;
    }

    formState[item.key] = item.control === 'switch' ? Boolean(raw) : String(raw);
  });

  return formState;
};

const toValidationCandidateValue = (item: SettingDefinition, draftValue: SettingsFormValue): unknown => {
  if (item.control === 'json') {
    return draftValue;
  }

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
    item.key,
    item.path,
    item.commandActionId,
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

const toDefaultFormValue = (item: SettingDefinition): SettingsFormValue => {
  if (item.control === 'json') {
    return cloneJsonSettingValue(item.defaultValue);
  }

  if (item.control === 'switch') {
    return Boolean(item.defaultValue);
  }

  return String(item.defaultValue);
};

/**
 * Resolves time zones supported by the current JavaScript runtime.
 *
 * @returns Sorted selectable time-zone values, excluding the system sentinel.
 */
const resolveSupportedTimeZoneOptions = (): string[] => {
  const supportedValuesOf = Intl.supportedValuesOf;
  const runtimeOptions =
    typeof supportedValuesOf === 'function' ? supportedValuesOf.call(Intl, 'timeZone') : FALLBACK_TIME_ZONE_OPTIONS;
  return [...new Set(['UTC', ...runtimeOptions])].sort((left, right) => left.localeCompare(right));
};

/**
 * Reads a numeric Intl date-time part.
 *
 * @param parts Intl formatted parts.
 * @param type Part type to read.
 * @returns Numeric value or zero when unavailable.
 */
const readNumericDateTimePart = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number => {
  return Number(parts.find((part) => part.type === type)?.value ?? '0');
};

/**
 * Resolves the current UTC offset for an IANA time zone.
 *
 * @param timeZone IANA time zone.
 * @param referenceDate Date used for daylight-saving aware offset calculation.
 * @returns Offset in minutes, or null when the runtime rejects the time zone.
 */
const resolveTimeZoneOffsetMinutes = (timeZone: string, referenceDate: Date): number | null => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      second: '2-digit',
      timeZone,
      year: 'numeric',
    }).formatToParts(referenceDate);

    const timeZoneTimestamp = Date.UTC(
      readNumericDateTimePart(parts, 'year'),
      readNumericDateTimePart(parts, 'month') - 1,
      readNumericDateTimePart(parts, 'day'),
      readNumericDateTimePart(parts, 'hour'),
      readNumericDateTimePart(parts, 'minute'),
      readNumericDateTimePart(parts, 'second'),
    );

    return Math.round((timeZoneTimestamp - referenceDate.getTime()) / 60_000);
  } catch {
    return null;
  }
};

/**
 * Formats an offset in minutes using compact UTC notation.
 *
 * @param offsetMinutes Offset in minutes.
 * @returns Display text such as (+8) or (-3:30).
 */
const formatTimeZoneOffsetLabel = (offsetMinutes: number): string => {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;

  if (minutes === 0) {
    return `(${sign}${hours})`;
  }

  return `(${sign}${hours}:${String(minutes).padStart(2, '0')})`;
};

/**
 * Formats an offset in minutes without wrapper parentheses.
 *
 * @param offsetMinutes Offset in minutes.
 * @returns Display text such as +8 or -3:30.
 */
const formatTimeZoneOffsetValue = (offsetMinutes: number): string => {
  return formatTimeZoneOffsetLabel(offsetMinutes).slice(1, -1);
};

/**
 * Builds a selectable time-zone label with its current UTC offset.
 *
 * @param timeZone IANA time zone.
 * @param referenceDate Date used for daylight-saving aware offset calculation.
 * @returns Display label for a time-zone option.
 */
const formatTimeZoneOptionLabel = (timeZone: string, referenceDate: Date): string => {
  const offsetMinutes = resolveTimeZoneOffsetMinutes(timeZone, referenceDate);
  return offsetMinutes === null ? timeZone : `${timeZone} ${formatTimeZoneOffsetLabel(offsetMinutes)}`;
};

/**
 * Builds the system time-zone option label with the resolved OS time zone when available.
 *
 * @param referenceDate Date used for daylight-saving aware offset calculation.
 * @returns Localized system time-zone label.
 */
const formatSystemTimeZoneOptionLabel = (referenceDate: Date): string => {
  const systemLabel = t('settings.options.dateTimeTimeZone.system');
  const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!resolvedTimeZone) {
    return systemLabel;
  }

  const offsetMinutes = resolveTimeZoneOffsetMinutes(resolvedTimeZone, referenceDate);
  const offsetLabel = offsetMinutes === null ? '' : `, ${formatTimeZoneOffsetValue(offsetMinutes)}`;
  return `${systemLabel} (${resolvedTimeZone}${offsetLabel})`;
};

type SettingsProps = {
  initialCategoryId?: SettingsCategoryId;
  initialSearchQuery?: string;
  onOpenSettingInEditor?: (settingKey: SettingKey) => void;
};

const Settings: React.FC<SettingsProps> = ({ initialCategoryId, initialSearchQuery, onOpenSettingInEditor }) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const contentStartRef = React.useRef<HTMLDivElement | null>(null);
  const [, setLocaleTick] = React.useState<number>(0);
  const [activeCategoryId, setActiveCategoryId] = React.useState<SettingsCategoryId>(
    () => initialCategoryId ?? 'general',
  );
  const [search, setSearch] = React.useState<string>(() => initialSearchQuery?.trim() ?? '');
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

  React.useLayoutEffect(() => {
    // Category switches should start at the top of the new settings surface.
    contentStartRef.current?.scrollIntoView({ behavior: 'auto', block: 'start', inline: 'nearest' });
  }, [activeCategoryId]);

  const normalizedSearch = search.trim().toLowerCase();
  const isSearchMode = normalizedSearch.length > 0;
  const exactSettingKeySearch = React.useMemo<SettingKey | null>(() => {
    if (!normalizedSearch) {
      return null;
    }

    const matchedSetting = SETTINGS_REGISTRY.find((item) => item.key.toLowerCase() === normalizedSearch);
    return matchedSetting?.key ?? null;
  }, [normalizedSearch]);

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

    if (exactSettingKeySearch) {
      return SETTINGS_REGISTRY.filter((item) => item.key === exactSettingKeySearch);
    }

    return SETTINGS_REGISTRY.filter((item) => {
      const categoryLabel = resolveCategoryLabel(item.category);
      const descriptionText = t(item.descriptionI18nKey);
      return matchesSearch(item, categoryLabel, descriptionText, normalizedSearch);
    });
  }, [exactSettingKeySearch, normalizedSearch]);

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

      if (item.key === 'serverProxyUrl') {
        return formState.serverProxyMode === 'custom';
      }

      if (item.key === 'terminalInlineImageOptions') {
        return formState.terminalInlineImagesEnabled === true;
      }

      return true;
    });
  }, [
    categorySettings,
    formState.terminalAutoCompleteEnabled,
    formState.terminalInlineImagesEnabled,
    formState.terminalSelectionSearchEngine,
    formState.serverProxyMode,
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
    (item: SettingDefinition, controlId: string): React.ReactNode => {
      if (item.key === 'autoSaveEnabled') {
        return (
          <div className="flex items-center gap-2.5 px-2.5">
            <Switch
              id={controlId}
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

      if (item.control === 'json') {
        return (
          <div className="px-2.5">
            <button
              id={controlId}
              type="button"
              className="text-home-text inline-flex text-sm underline underline-offset-2 hover:text-home-text-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-outline disabled:pointer-events-none disabled:opacity-55"
              disabled={!onOpenSettingInEditor}
              onClick={() => onOpenSettingInEditor?.(item.key)}
            >
              {t('settings.itemActions.editInSettingsEditor')}
            </button>
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
              <SelectTrigger id={controlId}>
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

        if (item.key === 'dateTimeTimeZone') {
          const currentValue = value.trim();
          const referenceDate = new Date();
          const timeZoneOptions = resolveSupportedTimeZoneOptions();
          const hasCurrentValue =
            currentValue.length > 0 && currentValue !== 'system' && timeZoneOptions.includes(currentValue);
          const options = [
            { value: 'system', label: formatSystemTimeZoneOptionLabel(referenceDate) },
            ...(currentValue.length > 0 && currentValue !== 'system' && !hasCurrentValue
              ? [{ value: currentValue, label: formatTimeZoneOptionLabel(currentValue, referenceDate) }]
              : []),
            ...timeZoneOptions.map((timeZone) => ({
              value: timeZone,
              label: formatTimeZoneOptionLabel(timeZone, referenceDate),
            })),
          ];

          return (
            <Select
              value={currentValue || 'system'}
              onValueChange={(nextValue) => {
                updateField(item.key, nextValue);
              }}
            >
              <SelectTrigger id={controlId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
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
            <SelectTrigger id={controlId}>
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
              id={controlId}
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
            id={controlId}
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
          id={controlId}
          value={String(formState[item.key])}
          inputMode={item.inputMode}
          placeholder={item.placeholderI18nKey ? t(item.placeholderI18nKey) : undefined}
          onChange={(event) => {
            updateField(item.key, event.target.value);
          }}
        />
      );
    },
    [formState, localTerminalProfiles, onOpenSettingInEditor, persistSettings, updateField],
  );

  return (
    <SplitWorkbenchLayout
      sidebar={
        <>
          <div className="pb-3">
            <Menubar className="w-full">
              <div className="relative w-full">
                <Input
                  value={search}
                  aria-label={t('settings.searchPlaceholder')}
                  placeholder={t('settings.searchPlaceholder')}
                  className="pr-9"
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
              </div>
            </Menubar>
          </div>

          <div className="gutter-box-y min-h-0 flex-1 overflow-auto pb-2">
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
        </>
      }
      main={
        <SplitWorkbenchMainPanel
          header={
            <div className="mx-auto flex min-h-[46px] max-w-4xl items-center justify-between gap-4 pb-1">
              <div className="grid gap-1">
                <h1 className="text-home-text ps-2 text-[24px] font-semibold">
                  {isSearchMode ? t('settings.searchResults') : t(activeCategory.labelI18nKey)}
                </h1>
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
          }
          body={
            <div className="mx-auto max-w-4xl flex-1">
              <div
                ref={contentStartRef}
                aria-hidden="true"
              />

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
                      <div className="px-2.5 pb-1 text-[15px] font-medium text-home-text-subtle">{section.title}</div>
                      {section.items.map((item) => {
                        const controlId = `settings-control-${item.key}`;

                        return (
                          <FormField
                            key={item.path}
                            className="group/setting"
                          >
                            <div className="flex items-center">
                              <Label htmlFor={controlId}>{t(item.nameI18nKey)}</Label>
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
                                  {item.control !== 'json' ? (
                                    <DropdownMenuItem
                                      icon={Settings2}
                                      onSelect={() => onOpenSettingInEditor?.(item.key)}
                                    >
                                      {t('settings.itemActions.editInSettingsEditor')}
                                    </DropdownMenuItem>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                            {renderControl(item, controlId)}
                            <div className={formStyles.helperText}>{t(item.descriptionI18nKey)}</div>
                          </FormField>
                        );
                      })}
                    </section>
                  ))}
                </div>
              ) : null}

              {!isLoading && activeCategoryId === 'mcp' && !isSearchMode ? <SettingsMcpSection /> : null}

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
          }
        />
      }
    >
      <Dialog
        open={isDatabaseSecurityDialogOpen}
        onOpenChange={setIsDatabaseSecurityDialogOpen}
      >
        <DialogContent className="max-w-[760px]">
          <DialogHeader>
            <DialogTitle>{t('settings.databaseSecurity.title')}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-2 rounded-md border border-home-divider p-3 text-sm">
            <DialogDescription className="pb-1 text-home-text-subtle">
              {t('settings.databaseSecurity.description')}
            </DialogDescription>

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
    </SplitWorkbenchLayout>
  );
};

export default Settings;
