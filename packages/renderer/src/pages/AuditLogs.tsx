import type {
  ApiAuditEventDetailResponse,
  ApiAuditEventListQuery,
  ApiAuditEventListResponse,
} from '@cosmosh/api-contract';
import classNames from 'classnames';
import { ChevronLeft, ChevronRight, ClipboardList, Info, Loader2, RefreshCcw, Search, ShieldCheck } from 'lucide-react';
import React from 'react';

import HomeEmptyState from '../components/home/HomeEmptyState';
import SplitWorkbenchLayout, { SplitWorkbenchMainPanel } from '../components/layout/SplitWorkbenchLayout';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { menuStyles } from '../components/ui/menu-styles';
import { Menubar, MenubarSeparator } from '../components/ui/menubar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { getAuditEventById, listAuditEvents } from '../lib/backend';
import { useDateTimeFormatter } from '../lib/date-time-format';
import { t } from '../lib/i18n';
import { useToast } from '../lib/toast-context';

type TimeRangePreset = '24h' | '7d' | '30d' | '180d';

type AuditEventListItem = ApiAuditEventListResponse['data']['items'][number];
type AuditEventDetailItem = ApiAuditEventDetailResponse['data']['item'];

type AuditEventPagination = ApiAuditEventListResponse['data']['pagination'];

type DateTimeFormatter = (value: string | number | Date, fallback?: string) => string;

type DetailField = {
  labelKey: string;
  value: string;
  tone?: 'default' | 'success' | 'danger' | 'warning';
};

const DEFAULT_PAGE_SIZE = 50;
const ALL_CATEGORY_FILTER_VALUE = '__all_categories__';
const ALL_OUTCOME_FILTER_VALUE = '__all_outcomes__';
const AUDIT_EVENT_TABLE_GRID_CLASS =
  'grid w-full min-w-[740px] grid-cols-[150px_minmax(210px,1fr)_128px_92px_120px] gap-2';
const AUDIT_EVENT_PANEL_CLASS_NAME = 'bg-ssh-card-bg-terminal h-full min-h-0 overflow-hidden rounded-[18px] p-1';

/**
 * Resolves list query start time from a preset value.
 *
 * @param preset Time range preset.
 * @returns Date object used for list filtering.
 */
const resolvePresetStartAt = (preset: TimeRangePreset): Date => {
  const now = Date.now();

  if (preset === '24h') {
    return new Date(now - 24 * 60 * 60 * 1000);
  }

  if (preset === '7d') {
    return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }

  if (preset === '30d') {
    return new Date(now - 30 * 24 * 60 * 60 * 1000);
  }

  return new Date(now - 180 * 24 * 60 * 60 * 1000);
};

/**
 * Formats metadata object to readable JSON block.
 *
 * @param metadata Metadata object.
 * @returns Pretty JSON string.
 */
const formatMetadataJson = (metadata: Record<string, unknown>): string => {
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return '{}';
  }
};

/**
 * Builds the category translation key for known audit categories.
 *
 * @param category Audit event category.
 * @returns Localized category label or the original category.
 */
const formatAuditCategory = (category: string): string => {
  const categoryLabelKeys: Record<string, string> = {
    mcp: 'auditLogs.categories.mcp',
    'port-forward': 'auditLogs.categories.portForward',
    settings: 'auditLogs.categories.settings',
    'sftp-session': 'auditLogs.categories.sftpSession',
    'ssh-host-trust': 'auditLogs.categories.hostTrust',
    'ssh-keychain': 'auditLogs.categories.sshKeychain',
    'ssh-server': 'auditLogs.categories.sshServer',
    'ssh-session': 'auditLogs.categories.sshSession',
  };

  const labelKey = categoryLabelKeys[category];
  return labelKey ? t(labelKey) : category;
};

/**
 * Formats an audit action name for display.
 *
 * @param action Audit event action.
 * @returns Human-readable action label.
 */
const formatAuditAction = (action: string): string => action.replace(/[-_]+/g, ' ');

/**
 * Resolves the localized outcome label.
 *
 * @param outcome Audit event outcome.
 * @returns Localized outcome label.
 */
const formatAuditOutcome = (outcome: AuditEventListItem['outcome']): string => {
  return outcome === 'success' ? t('auditLogs.outcomes.success') : t('auditLogs.outcomes.failure');
};

/**
 * Resolves the localized severity label.
 *
 * @param severity Audit event severity.
 * @returns Localized severity label.
 */
const formatAuditSeverity = (severity: AuditEventListItem['severity']): string => {
  return t(`auditLogs.severity.${severity}`);
};

/**
 * Resolves row text color for outcome values.
 *
 * @param outcome Audit event outcome.
 * @returns Tailwind class for the outcome tone.
 */
const resolveOutcomeClassName = (outcome: AuditEventListItem['outcome']): string => {
  return outcome === 'success' ? 'text-status-good' : 'text-status-bad';
};

/**
 * Resolves row text color for severity values.
 *
 * @param severity Audit event severity.
 * @returns Tailwind class for the severity tone.
 */
const resolveSeverityClassName = (severity: AuditEventListItem['severity']): string => {
  if (severity === 'critical') {
    return 'text-status-bad';
  }

  if (severity === 'warning') {
    return 'text-status-warn';
  }

  return 'text-home-text-subtle';
};

/**
 * Formats the audit target identity.
 *
 * @param item Audit event item.
 * @returns Compact target label.
 */
const formatAuditTarget = (item: Pick<AuditEventListItem, 'entityId' | 'entityType'>): string => {
  if (!item.entityType && !item.entityId) {
    return t('auditLogs.columns.noneTarget');
  }

  if (!item.entityType) {
    return item.entityId ?? t('auditLogs.columns.noneTarget');
  }

  if (!item.entityId) {
    return item.entityType;
  }

  return `${item.entityType}:${item.entityId}`;
};

/**
 * Resolves missing optional audit values to the shared empty placeholder.
 *
 * @param value Optional field value.
 * @returns Displayable value.
 */
const formatOptionalAuditValue = (value: string | undefined): string => {
  return value && value.trim().length > 0 ? value : t('auditLogs.fields.emptyValue');
};

/**
 * Resolves tone classes for detail field values.
 *
 * @param tone Detail field tone.
 * @returns Tailwind class for the value.
 */
const resolveDetailFieldToneClassName = (tone: DetailField['tone']): string => {
  if (tone === 'success') {
    return 'text-status-good';
  }

  if (tone === 'danger') {
    return 'text-status-bad';
  }

  if (tone === 'warning') {
    return 'text-status-warn';
  }

  return 'text-home-text';
};

/**
 * Builds a list query using fresh wall-clock bounds for each list request.
 *
 * @param params Active filter and pagination state.
 * @returns API list query.
 */
const buildAuditListQuery = (params: {
  categoryFilter: string;
  outcomeFilter: string;
  page: number;
  searchKeyword: string;
  timeRangePreset: TimeRangePreset;
}): ApiAuditEventListQuery => {
  const startAt = resolvePresetStartAt(params.timeRangePreset);
  const endAt = new Date();
  const keyword = params.searchKeyword.trim();

  return {
    page: params.page,
    pageSize: DEFAULT_PAGE_SIZE,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    ...(keyword.length > 0 ? { keyword } : {}),
    ...(params.categoryFilter.trim().length > 0 ? { category: params.categoryFilter } : {}),
    ...(params.outcomeFilter.trim().length > 0 ? { outcome: params.outcomeFilter } : {}),
  };
};

type DetailSectionProps = {
  title: string;
  fields: DetailField[];
};

/**
 * Renders a compact group of audit detail fields.
 *
 * @param props Section title and fields.
 * @returns Detail section.
 */
const DetailSection: React.FC<DetailSectionProps> = ({ fields, title }) => {
  return (
    <section>
      <h3 className="pb-1.5 text-xs font-medium uppercase tracking-[0.04em] text-home-text-subtle">{title}</h3>
      <dl className="space-y-2">
        {fields.map((field) => (
          <div
            key={field.labelKey}
            className="grid grid-cols-[118px_minmax(0,1fr)] items-start gap-2"
          >
            <dt className="text-xs text-home-text-subtle">{t(field.labelKey)}</dt>
            <dd
              className={classNames(
                'select-text break-all font-mono text-xs',
                resolveDetailFieldToneClassName(field.tone),
              )}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

type AuditEventListPanelProps = {
  items: AuditEventListItem[];
  loading: boolean;
  selectedEventId: string;
  formatDateTime: DateTimeFormatter;
  onSelectEvent: (eventId: string) => void;
};

/**
 * Renders the scroll-stable audit event list.
 *
 * @param props Audit list data, selected id, and selection callback.
 * @returns Audit event list panel.
 */
const AuditEventListPanel = React.memo<AuditEventListPanelProps>(
  ({ formatDateTime, items, loading, onSelectEvent, selectedEventId }) => {
    const showInitialLoading = loading && items.length === 0;

    return (
      <main className={AUDIT_EVENT_PANEL_CLASS_NAME}>
        <div className="h-full min-h-0 overflow-auto">
          <div className="flex min-h-full min-w-[740px] flex-col">
            <div
              className={classNames(
                AUDIT_EVENT_TABLE_GRID_CLASS,
                'sticky top-0 z-10 h-[30px] shrink-0 items-center bg-ssh-card-bg-terminal px-3 text-xs font-medium text-home-text-subtle',
              )}
            >
              <span>{t('auditLogs.columns.time')}</span>
              <span>{t('auditLogs.columns.event')}</span>
              <span>{t('auditLogs.columns.category')}</span>
              <span>{t('auditLogs.columns.outcome')}</span>
              <span>{t('auditLogs.columns.severity')}</span>
            </div>

            <div className="min-h-0 flex-1">
              {showInitialLoading ? (
                <div className="flex h-full min-h-[180px] items-center justify-center gap-2 px-4 text-center text-sm text-home-text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('auditLogs.loading')}
                </div>
              ) : null}

              {items.length === 0 && !loading ? (
                <HomeEmptyState
                  text={t('auditLogs.empty')}
                  icon={ClipboardList}
                />
              ) : null}

              {items.map((item) => {
                const isActive = item.eventId === selectedEventId;

                return (
                  <button
                    key={item.eventId}
                    type="button"
                    aria-selected={isActive}
                    className={classNames(
                      AUDIT_EVENT_TABLE_GRID_CLASS,
                      'h-[42px] items-center rounded-lg px-3 text-left text-[13px] transition-colors',
                      isActive ? 'text-home-text bg-home-card-hover' : 'text-home-text hover:bg-home-card-hover',
                    )}
                    onClick={() => onSelectEvent(item.eventId)}
                  >
                    <span className="truncate text-xs text-home-text-subtle">
                      {formatDateTime(item.occurredAt, item.occurredAt)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{formatAuditAction(item.action)}</span>
                      <span className="block truncate text-xs text-home-text-subtle">{formatAuditTarget(item)}</span>
                    </span>
                    <span className="truncate text-xs text-home-text-subtle">{formatAuditCategory(item.category)}</span>
                    <span className={classNames('truncate text-xs font-medium', resolveOutcomeClassName(item.outcome))}>
                      {formatAuditOutcome(item.outcome)}
                    </span>
                    <span
                      className={classNames('truncate text-xs font-medium', resolveSeverityClassName(item.severity))}
                    >
                      {formatAuditSeverity(item.severity)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    );
  },
);

AuditEventListPanel.displayName = 'AuditEventListPanel';

type AuditEventDetailPanelProps = {
  detail: AuditEventDetailItem | null;
  loading: boolean;
  formatDateTime: DateTimeFormatter;
};

/**
 * Renders the right-side selected audit event inspector.
 *
 * @param props Selected event detail and loading state.
 * @returns Audit event detail panel.
 */
const AuditEventDetailPanel = React.memo<AuditEventDetailPanelProps>(({ detail, formatDateTime, loading }) => {
  const metadataJson = React.useMemo(() => (detail ? formatMetadataJson(detail.metadata) : ''), [detail]);

  if (loading && !detail) {
    return (
      <aside className={AUDIT_EVENT_PANEL_CLASS_NAME}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-[34px] shrink-0 items-center gap-2 px-2">
            <Info className="h-4 w-4 shrink-0 text-home-text-subtle" />
            <div className="text-home-text min-w-0 flex-1 truncate text-sm font-medium">
              {t('auditLogs.detailTitle')}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-3 text-center text-sm text-home-text-subtle">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('auditLogs.detailLoading')}
          </div>
        </div>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className={AUDIT_EVENT_PANEL_CLASS_NAME}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-[34px] shrink-0 items-center gap-2 px-2">
            <Info className="h-4 w-4 shrink-0 text-home-text-subtle" />
            <div className="text-home-text min-w-0 flex-1 truncate text-sm font-medium">
              {t('auditLogs.detailTitle')}
            </div>
          </div>
          <HomeEmptyState
            text={t('auditLogs.detailEmpty')}
            icon={ClipboardList}
            className="py-4"
          />
        </div>
      </aside>
    );
  }

  const identityFields: DetailField[] = [
    {
      labelKey: 'auditLogs.fields.eventId',
      value: detail.eventId,
    },
    {
      labelKey: 'auditLogs.fields.occurredAt',
      value: formatDateTime(detail.occurredAt, detail.occurredAt),
    },
    {
      labelKey: 'auditLogs.fields.retentionUntilAt',
      value: formatDateTime(detail.retentionUntilAt, detail.retentionUntilAt),
    },
  ];

  const scopeFields: DetailField[] = [
    {
      labelKey: 'auditLogs.fields.scopeAccountId',
      value: formatOptionalAuditValue(detail.scopeAccountId),
    },
    {
      labelKey: 'auditLogs.fields.scopeDeviceId',
      value: formatOptionalAuditValue(detail.scopeDeviceId),
    },
    {
      labelKey: 'auditLogs.fields.entity',
      value: formatAuditTarget(detail),
    },
  ];

  const correlationFields: DetailField[] = [
    {
      labelKey: 'auditLogs.fields.sessionId',
      value: formatOptionalAuditValue(detail.sessionId),
    },
    {
      labelKey: 'auditLogs.fields.requestId',
      value: formatOptionalAuditValue(detail.requestId),
    },
    {
      labelKey: 'auditLogs.fields.correlationId',
      value: formatOptionalAuditValue(detail.correlationId),
    },
    {
      labelKey: 'auditLogs.fields.relatedRecordId',
      value: formatOptionalAuditValue(detail.relatedRecordId),
    },
  ];

  return (
    <aside className={AUDIT_EVENT_PANEL_CLASS_NAME}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-[34px] shrink-0 items-center gap-2 px-2">
          <Info className="h-4 w-4 shrink-0 text-home-text-subtle" />
          <div className="text-home-text min-w-0 flex-1 truncate text-sm font-medium">{t('auditLogs.detailTitle')}</div>
          {loading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-home-text-subtle" /> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          <div className="space-y-4 text-[13px]">
            <div className="flex min-w-0 items-center gap-2">
              <ShieldCheck className="text-home-text h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="text-home-text truncate text-sm font-medium">{formatAuditAction(detail.action)}</div>
                <div className="mt-0.5 truncate text-xs text-home-text-subtle">
                  {formatAuditCategory(detail.category)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-home-card/70 rounded-lg p-2">
                <div className="text-xs text-home-text-subtle">{t('auditLogs.fields.outcome')}</div>
                <div className={classNames('mt-1 text-sm font-medium', resolveOutcomeClassName(detail.outcome))}>
                  {formatAuditOutcome(detail.outcome)}
                </div>
              </div>
              <div className="bg-home-card/70 rounded-lg p-2">
                <div className="text-xs text-home-text-subtle">{t('auditLogs.fields.severity')}</div>
                <div className={classNames('mt-1 text-sm font-medium', resolveSeverityClassName(detail.severity))}>
                  {formatAuditSeverity(detail.severity)}
                </div>
              </div>
            </div>

            <DetailSection
              title={t('auditLogs.detailSections.identity')}
              fields={identityFields}
            />
            <DetailSection
              title={t('auditLogs.detailSections.scope')}
              fields={scopeFields}
            />
            <DetailSection
              title={t('auditLogs.detailSections.correlation')}
              fields={correlationFields}
            />

            <div>
              <h3 className="pb-1.5 text-xs font-medium uppercase tracking-[0.04em] text-home-text-subtle">
                {t('auditLogs.metadata')}
              </h3>
              <pre className="-mx-1 -mb-1 max-h-[360px] overflow-auto rounded-lg bg-bg p-2.5 text-[11px] leading-5 text-home-text-subtle">
                {metadataJson}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
});

AuditEventDetailPanel.displayName = 'AuditEventDetailPanel';

const AuditLogs: React.FC = () => {
  const { warning: notifyWarning } = useToast();
  const { formatDateTime } = useDateTimeFormatter();

  const [searchKeyword, setSearchKeyword] = React.useState<string>('');
  const [categoryFilter, setCategoryFilter] = React.useState<string>('');
  const [outcomeFilter, setOutcomeFilter] = React.useState<string>('');
  const [timeRangePreset, setTimeRangePreset] = React.useState<TimeRangePreset>('180d');
  const [page, setPage] = React.useState<number>(1);

  const [loadingList, setLoadingList] = React.useState<boolean>(false);
  const [listResponse, setListResponse] = React.useState<ApiAuditEventListResponse | null>(null);
  const [selectedEventId, setSelectedEventId] = React.useState<string>('');

  const [loadingDetail, setLoadingDetail] = React.useState<boolean>(false);
  const [detail, setDetail] = React.useState<AuditEventDetailItem | null>(null);
  const selectedEventIdRef = React.useRef<string>('');

  React.useEffect(() => {
    selectedEventIdRef.current = selectedEventId;
  }, [selectedEventId]);

  const refreshList = React.useCallback(async () => {
    setLoadingList(true);

    try {
      const query = buildAuditListQuery({
        categoryFilter,
        outcomeFilter,
        page,
        searchKeyword,
        timeRangePreset,
      });
      const response = await listAuditEvents(query);
      setListResponse(response);

      const firstEventId = response.data.items[0]?.eventId ?? '';
      const selectedStillVisible = response.data.items.some((item) => item.eventId === selectedEventIdRef.current);
      if (!selectedStillVisible) {
        setSelectedEventId(firstEventId);
      }
    } catch (error: unknown) {
      notifyWarning(error instanceof Error ? error.message : t('auditLogs.loadFailed'));
      setListResponse(null);
      setSelectedEventId('');
    } finally {
      setLoadingList(false);
    }
  }, [categoryFilter, notifyWarning, outcomeFilter, page, searchKeyword, timeRangePreset]);

  React.useEffect(() => {
    void refreshList();
  }, [refreshList]);

  React.useEffect(() => {
    if (!selectedEventId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetail(null);
    setLoadingDetail(true);

    void getAuditEventById(selectedEventId)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setDetail(response.data.item);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        notifyWarning(error instanceof Error ? error.message : t('auditLogs.detailLoadFailed'));
        setDetail(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [notifyWarning, selectedEventId]);

  const listItems: AuditEventListItem[] = listResponse?.data.items ?? [];
  const pagination: AuditEventPagination | undefined = listResponse?.data.pagination;
  const handleSelectedEventChange = React.useCallback((eventId: string): void => {
    setSelectedEventId(eventId);
  }, []);

  return (
    <SplitWorkbenchLayout
      sidebar={
        <>
          <div className="pb-3">
            <Menubar className="w-full">
              <div className="relative w-full">
                <Input
                  value={searchKeyword}
                  placeholder={t('auditLogs.filters.keywordPlaceholder')}
                  className="pr-9"
                  onChange={(event) => {
                    setPage(1);
                    setSearchKeyword(event.target.value);
                  }}
                />
                <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
              </div>

              <MenubarSeparator vertical />

              <button
                type="button"
                aria-label={t('auditLogs.actions.refresh')}
                className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
                onClick={() => {
                  void refreshList();
                }}
              >
                <RefreshCcw className="h-4 w-4" />
              </button>
            </Menubar>
          </div>

          <div className="gutter-box-y min-h-0 flex-1 overflow-auto pb-2">
            <div className="space-y-3">
              <div className="grid gap-2">
                <Label
                  htmlFor="audit-logs-category-filter"
                  className="px-0 text-xs font-medium text-home-text-subtle"
                >
                  {t('auditLogs.filters.category')}
                </Label>
                <Select
                  value={categoryFilter || ALL_CATEGORY_FILTER_VALUE}
                  onValueChange={(value) => {
                    setPage(1);
                    setCategoryFilter(value === ALL_CATEGORY_FILTER_VALUE ? '' : value);
                  }}
                >
                  <SelectTrigger id="audit-logs-category-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CATEGORY_FILTER_VALUE}>{t('auditLogs.filters.allCategories')}</SelectItem>
                    <SelectItem value="ssh-session">{t('auditLogs.categories.sshSession')}</SelectItem>
                    <SelectItem value="ssh-server">{t('auditLogs.categories.sshServer')}</SelectItem>
                    <SelectItem value="ssh-keychain">{t('auditLogs.categories.sshKeychain')}</SelectItem>
                    <SelectItem value="settings">{t('auditLogs.categories.settings')}</SelectItem>
                    <SelectItem value="ssh-host-trust">{t('auditLogs.categories.hostTrust')}</SelectItem>
                    <SelectItem value="port-forward">{t('auditLogs.categories.portForward')}</SelectItem>
                    <SelectItem value="sftp-session">{t('auditLogs.categories.sftpSession')}</SelectItem>
                    <SelectItem value="mcp">{t('auditLogs.categories.mcp')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label
                  htmlFor="audit-logs-outcome-filter"
                  className="px-0 text-xs font-medium text-home-text-subtle"
                >
                  {t('auditLogs.filters.outcome')}
                </Label>
                <Select
                  value={outcomeFilter || ALL_OUTCOME_FILTER_VALUE}
                  onValueChange={(value) => {
                    setPage(1);
                    setOutcomeFilter(value === ALL_OUTCOME_FILTER_VALUE ? '' : value);
                  }}
                >
                  <SelectTrigger id="audit-logs-outcome-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_OUTCOME_FILTER_VALUE}>{t('auditLogs.filters.allOutcomes')}</SelectItem>
                    <SelectItem value="success">{t('auditLogs.outcomes.success')}</SelectItem>
                    <SelectItem value="failure">{t('auditLogs.outcomes.failure')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label
                  htmlFor="audit-logs-time-range-filter"
                  className="px-0 text-xs font-medium text-home-text-subtle"
                >
                  {t('auditLogs.filters.timeRange')}
                </Label>
                <Select
                  value={timeRangePreset}
                  onValueChange={(value) => {
                    setPage(1);
                    setTimeRangePreset(value as TimeRangePreset);
                  }}
                >
                  <SelectTrigger id="audit-logs-time-range-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24h">{t('auditLogs.timeRange.last24h')}</SelectItem>
                    <SelectItem value="7d">{t('auditLogs.timeRange.last7d')}</SelectItem>
                    <SelectItem value="30d">{t('auditLogs.timeRange.last30d')}</SelectItem>
                    <SelectItem value="180d">{t('auditLogs.timeRange.last180d')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-4 rounded-lg-2 bg-bg-subtle p-3 text-xs text-home-text-subtle">
              {t('auditLogs.retentionHint')}
            </div>
          </div>
        </>
      }
      main={
        <SplitWorkbenchMainPanel
          header={
            <div className="items-top mx-auto flex min-h-[46px] justify-between gap-4 pb-1">
              <div className="grid gap-1">
                <h1 className="text-home-text ps-2 text-[24px] font-semibold">{t('auditLogs.title')}</h1>
                <p className="ps-2 text-sm text-home-text-subtle">
                  {t('auditLogs.countSummary', {
                    count: String(pagination?.total ?? 0),
                  })}
                </p>
              </div>

              <Menubar>
                <Button
                  variant="icon"
                  aria-label={t('auditLogs.pagination.page', { page: String(page - 1) })}
                  disabled={!pagination || page <= 1 || loadingList}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                <span className="px-2 text-sm">
                  {t('auditLogs.pagination.page', {
                    page: String(pagination?.page ?? 1),
                  })}
                </span>

                <Button
                  variant="icon"
                  aria-label={t('auditLogs.pagination.page', { page: String(page + 1) })}
                  disabled={!pagination || !pagination.hasMore || loadingList}
                  onClick={() => setPage((current) => current + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </Menubar>
            </div>
          }
          bodyClassName=""
          body={
            <div className="-mb-2 -me-3 -ms-1 grid h-full min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(330px,0.42fr)] gap-3 overflow-hidden">
              <AuditEventListPanel
                formatDateTime={formatDateTime}
                items={listItems}
                loading={loadingList}
                selectedEventId={selectedEventId}
                onSelectEvent={handleSelectedEventChange}
              />
              <AuditEventDetailPanel
                detail={detail}
                formatDateTime={formatDateTime}
                loading={loadingDetail}
              />
            </div>
          }
        />
      }
    />
  );
};

export default AuditLogs;
