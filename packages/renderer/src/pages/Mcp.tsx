import type {
  ApiMcpClientSession,
  ApiMcpConnectionSummary,
  ApiMcpPendingApproval,
  ApiMcpStatusData,
} from '@cosmosh/api-contract';
import classNames from 'classnames';
import { Copy, KeyRound, Loader2, Plug, RefreshCcw, Trash2, Waypoints, XCircle } from 'lucide-react';
import React from 'react';

import { Button } from '../components/ui/button';
import {
  closeMcpConnection,
  getMcpStatus,
  listMcpApprovals,
  listMcpClients,
  listMcpConnections,
  revokeMcpPairingToken,
  rotateMcpPairingToken,
} from '../lib/backend';
import { useDateTimeFormatter } from '../lib/date-time-format';
import { t } from '../lib/i18n';
import { setMcpApprovals, setMcpClients, setMcpConnections, setMcpStatus, useMcpStore } from '../lib/mcp-store';
import { useSettingsValue } from '../lib/settings-store';
import { useToast } from '../lib/toast-context';

type StatusPillTone = 'on' | 'off' | 'muted';

/**
 * Renders a small labelled status pill.
 *
 * @param props Pill label and tone.
 * @returns Status pill element.
 */
const StatusPill: React.FC<{ label: string; tone: StatusPillTone }> = ({ label, tone }) => (
  <span
    className={classNames('rounded-full px-2.5 py-1 text-xs font-medium', {
      'bg-emerald-500/15 text-emerald-400': tone === 'on',
      'bg-red-500/15 text-red-400': tone === 'off',
      'bg-white/10 text-header-text-muted': tone === 'muted',
    })}
  >
    {label}
  </span>
);

/**
 * Renders a section card wrapper with a title and optional actions.
 *
 * @param props Section heading, actions, and body content.
 * @returns Card element.
 */
const SectionCard: React.FC<{
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, actions, children }) => (
  <section className="rounded-2xl bg-ssh-card-bg-terminal p-4">
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold text-form-text">{title}</h2>
        {description ? <p className="text-xs text-header-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
    {children}
  </section>
);

/**
 * Renders a monospace value row with a copy-to-clipboard button.
 *
 * @param props Row label, value, and copy handler.
 * @returns Copyable row element.
 */
const CopyableRow: React.FC<{ label: string; value: string; onCopy: (value: string) => void }> = ({
  label,
  value,
  onCopy,
}) => (
  <div className="grid gap-1">
    <span className="text-xs text-header-text-muted">{label}</span>
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-black/20 px-2 py-1 font-mono text-xs text-form-text">
        {value}
      </code>
      <Button
        variant="ghostIcon"
        aria-label={t('mcp.actions.copy')}
        onClick={() => onCopy(value)}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  </div>
);

/**
 * MCP management panel — runtime status, pairing token, connected clients,
 * active SSH connections, and the pending-approval queue.
 *
 * The reactive lists are backed by the shared MCP store (kept live by the global
 * approval host's event channel); this page adds an explicit refresh and the
 * management actions (token rotation/revocation, connection close).
 *
 * @returns MCP management page.
 */
const Mcp: React.FC = () => {
  const mcpEnabled = useSettingsValue('mcpEnabled');
  const { status, clients, connections, approvals, channelState } = useMcpStore();
  const { formatDateTime } = useDateTimeFormatter();
  const { success: notifySuccess, error: notifyError } = useToast();

  const [refreshing, setRefreshing] = React.useState<boolean>(false);
  const [rotating, setRotating] = React.useState<boolean>(false);
  const [revoking, setRevoking] = React.useState<boolean>(false);
  const [closingId, setClosingId] = React.useState<string | null>(null);
  const [freshToken, setFreshToken] = React.useState<string | null>(null);

  const refreshAll = React.useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const [statusResult, clientsResult, connectionsResult, approvalsResult] = await Promise.all([
        getMcpStatus(),
        listMcpClients(),
        listMcpConnections(),
        listMcpApprovals(),
      ]);
      setMcpStatus(statusResult.data);
      setMcpClients(clientsResult.data.items);
      setMcpConnections(connectionsResult.data.items);
      setMcpApprovals(approvalsResult.data.items);
    } catch {
      notifyError(t('mcp.errors.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  }, [notifyError]);

  React.useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const handleCopy = React.useCallback(
    (value: string): void => {
      void navigator.clipboard
        ?.writeText(value)
        .then(() => {
          notifySuccess(t('mcp.toasts.copied'));
        })
        .catch(() => {
          notifyError(t('mcp.errors.copyFailed'));
        });
    },
    [notifyError, notifySuccess],
  );

  const handleRotateToken = React.useCallback(async (): Promise<void> => {
    setRotating(true);
    try {
      const result = await rotateMcpPairingToken();
      setFreshToken(result.data.token);
      notifySuccess(t('mcp.toasts.tokenRotated'));
      await refreshAll();
    } catch {
      notifyError(t('mcp.errors.tokenRotateFailed'));
    } finally {
      setRotating(false);
    }
  }, [notifyError, notifySuccess, refreshAll]);

  const handleRevokeToken = React.useCallback(async (): Promise<void> => {
    setRevoking(true);
    try {
      const result = await revokeMcpPairingToken();
      if (result.success) {
        setFreshToken(null);
        notifySuccess(t('mcp.toasts.tokenRevoked'));
        await refreshAll();
      } else {
        notifyError(t('mcp.errors.tokenRevokeFailed'));
      }
    } catch {
      notifyError(t('mcp.errors.tokenRevokeFailed'));
    } finally {
      setRevoking(false);
    }
  }, [notifyError, notifySuccess, refreshAll]);

  const handleCloseConnection = React.useCallback(
    async (connectionId: string): Promise<void> => {
      setClosingId(connectionId);
      try {
        const result = await closeMcpConnection(connectionId);
        if (result.success) {
          setMcpConnections(connections.filter((item) => item.connectionId !== connectionId));
          notifySuccess(t('mcp.toasts.connectionClosed'));
        } else {
          notifyError(t('mcp.errors.connectionCloseFailed'));
        }
      } catch {
        notifyError(t('mcp.errors.connectionCloseFailed'));
      } finally {
        setClosingId((previous) => (previous === connectionId ? null : previous));
      }
    },
    [connections, notifyError, notifySuccess],
  );

  return (
    <div className="mx-auto grid h-full w-full max-w-3xl gap-4 overflow-y-auto p-6">
      <McpStatusHeader
        mcpEnabled={mcpEnabled}
        status={status}
        channelState={channelState}
        refreshing={refreshing}
        onRefresh={() => {
          void refreshAll();
        }}
      />

      {!mcpEnabled ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
          {t('mcp.disabledNotice')}
        </div>
      ) : null}

      <SectionCard
        title={t('mcp.token.title')}
        description={t('mcp.token.description')}
        actions={
          <>
            <Button
              variant="ghost"
              disabled={revoking || !status?.tokenConfigured}
              onClick={() => {
                void handleRevokeToken();
              }}
            >
              {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : t('mcp.token.revoke')}
            </Button>
            <Button
              variant="inverted"
              disabled={rotating}
              onClick={() => {
                void handleRotateToken();
              }}
            >
              {rotating ? <Loader2 className="h-4 w-4 animate-spin" /> : t('mcp.token.rotate')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="flex items-center gap-2 text-sm text-form-text">
            <KeyRound className="h-4 w-4 text-header-text-muted" />
            {status?.tokenConfigured ? t('mcp.token.configured') : t('mcp.token.notConfigured')}
          </div>
          {freshToken ? (
            <div className="grid gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
              <p className="text-xs text-emerald-300">{t('mcp.token.freshNotice')}</p>
              <CopyableRow
                label={t('mcp.token.tokenLabel')}
                value={freshToken}
                onCopy={handleCopy}
              />
            </div>
          ) : null}
          {status?.discoveryFilePath ? (
            <CopyableRow
              label={t('mcp.token.discoveryPath')}
              value={status.discoveryFilePath}
              onCopy={handleCopy}
            />
          ) : null}
          {status?.bridgeLauncherPath ? (
            <CopyableRow
              label={t('mcp.token.launcherPath')}
              value={status.bridgeLauncherPath}
              onCopy={handleCopy}
            />
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title={t('mcp.clients.title')}
        description={t('mcp.clients.description')}
      >
        <McpClientList
          clients={clients}
          formatDateTime={formatDateTime}
        />
      </SectionCard>

      <SectionCard
        title={t('mcp.connections.title')}
        description={t('mcp.connections.description')}
      >
        <McpConnectionList
          connections={connections}
          closingId={closingId}
          formatDateTime={formatDateTime}
          onClose={(connectionId) => {
            void handleCloseConnection(connectionId);
          }}
        />
      </SectionCard>

      <SectionCard
        title={t('mcp.approvals.title')}
        description={t('mcp.approvals.description')}
      >
        <McpApprovalList
          approvals={approvals}
          formatDateTime={formatDateTime}
        />
      </SectionCard>
    </div>
  );
};

/**
 * Renders the page heading with runtime status pills and a refresh control.
 *
 * @param props Runtime status and refresh handler.
 * @returns Status header element.
 */
const McpStatusHeader: React.FC<{
  mcpEnabled: boolean;
  status: ApiMcpStatusData | null;
  channelState: string;
  refreshing: boolean;
  onRefresh: () => void;
}> = ({ mcpEnabled, status, channelState, refreshing, onRefresh }) => (
  <header className="grid gap-3">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Waypoints className="h-5 w-5 text-form-text" />
        <h1 className="text-lg font-semibold text-form-text">{t('mcp.title')}</h1>
      </div>
      <Button
        variant="ghost"
        disabled={refreshing}
        onClick={onRefresh}
      >
        {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
        <span className="ml-2">{t('mcp.actions.refresh')}</span>
      </Button>
    </div>
    <p className="text-sm text-header-text-muted">{t('mcp.subtitle')}</p>
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill
        label={mcpEnabled ? t('mcp.status.enabled') : t('mcp.status.disabled')}
        tone={mcpEnabled ? 'on' : 'off'}
      />
      <StatusPill
        label={channelState === 'open' ? t('mcp.status.channelConnected') : t('mcp.status.channelDisconnected')}
        tone={channelState === 'open' ? 'on' : 'muted'}
      />
      <StatusPill
        label={t('mcp.status.clientCount', { count: String(status?.activeClientCount ?? 0) })}
        tone="muted"
      />
      <StatusPill
        label={t('mcp.status.connectionCount', { count: String(status?.activeConnectionCount ?? 0) })}
        tone="muted"
      />
      <StatusPill
        label={t('mcp.status.pendingCount', { count: String(status?.pendingApprovalCount ?? 0) })}
        tone="muted"
      />
    </div>
  </header>
);

/**
 * Renders the list of connected MCP client sessions.
 *
 * @param props Client sessions and a date formatter.
 * @returns Client list element.
 */
const McpClientList: React.FC<{
  clients: readonly ApiMcpClientSession[];
  formatDateTime: (value: string | number | Date, fallback?: string) => string;
}> = ({ clients, formatDateTime }) => {
  if (clients.length === 0) {
    return <p className="text-sm text-header-text-muted">{t('mcp.clients.empty')}</p>;
  }

  return (
    <ul className="grid gap-2">
      {clients.map((client) => (
        <li
          key={client.mcpSessionId}
          className="flex items-center justify-between gap-3 rounded-xl bg-black/10 px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-header-text-muted" />
            <span className="text-sm text-form-text">
              {client.client.name} {client.client.version}
            </span>
          </div>
          <span className="text-xs text-header-text-muted">
            {t('mcp.clients.started', { time: formatDateTime(client.startedAt) })}
          </span>
        </li>
      ))}
    </ul>
  );
};

/**
 * Renders the active SSH connection table with per-row close controls.
 *
 * @param props Connections, in-flight close id, formatter, and close handler.
 * @returns Connection list element.
 */
const McpConnectionList: React.FC<{
  connections: readonly ApiMcpConnectionSummary[];
  closingId: string | null;
  formatDateTime: (value: string | number | Date, fallback?: string) => string;
  onClose: (connectionId: string) => void;
}> = ({ connections, closingId, formatDateTime, onClose }) => {
  if (connections.length === 0) {
    return <p className="text-sm text-header-text-muted">{t('mcp.connections.empty')}</p>;
  }

  return (
    <ul className="grid gap-2">
      {connections.map((connection) => (
        <li
          key={connection.connectionId}
          className="grid gap-2 rounded-xl bg-black/10 px-3 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-form-text">{connection.serverName}</span>
            <Button
              variant="ghostIcon"
              aria-label={t('mcp.connections.close')}
              disabled={closingId === connection.connectionId}
              onClick={() => onClose(connection.connectionId)}
            >
              {closingId === connection.connectionId ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-header-text-muted">
            <span>
              {connection.username}@{connection.host}:{connection.port}
            </span>
            <span>{t('mcp.connections.commandCount', { count: String(connection.commandCount) })}</span>
            {connection.commandsPreApproved ? <span>{t('mcp.connections.preApproved')}</span> : null}
            <span>{t('mcp.connections.opened', { time: formatDateTime(connection.openedAt) })}</span>
          </div>
        </li>
      ))}
    </ul>
  );
};

/**
 * Renders the pending-approval queue in read-only form (resolution happens via
 * the global authorization dialog).
 *
 * @param props Pending approvals and a date formatter.
 * @returns Approval list element.
 */
const McpApprovalList: React.FC<{
  approvals: readonly ApiMcpPendingApproval[];
  formatDateTime: (value: string | number | Date, fallback?: string) => string;
}> = ({ approvals, formatDateTime }) => {
  if (approvals.length === 0) {
    return <p className="text-sm text-header-text-muted">{t('mcp.approvals.empty')}</p>;
  }

  return (
    <ul className="grid gap-2">
      {approvals.map((approval) => (
        <li
          key={approval.approvalId}
          className="grid gap-1 rounded-xl bg-black/10 px-3 py-2"
        >
          <div className="flex items-center gap-2">
            {approval.kind === 'command-execute' ? (
              <Plug className="h-4 w-4 text-amber-400" />
            ) : (
              <XCircle className="h-4 w-4 text-amber-400" />
            )}
            <span className="text-sm text-form-text">
              {approval.kind === 'command-execute' ? t('mcp.approvals.kindCommand') : t('mcp.approvals.kindConnection')}
            </span>
          </div>
          <div className="text-xs text-header-text-muted">
            {approval.client.name} · {approval.serverName} · {formatDateTime(approval.createdAt)}
          </div>
          {approval.command ? (
            <code className="truncate rounded-md bg-black/20 px-2 py-1 font-mono text-xs text-form-text">
              {approval.command}
            </code>
          ) : null}
        </li>
      ))}
    </ul>
  );
};

export default Mcp;
