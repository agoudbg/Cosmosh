import type { ApiMcpClientSession, ApiMcpConnectionSummary, ApiMcpPendingApproval } from '@cosmosh/api-contract';
import { Copy, KeyRound, Loader2, Plug, Trash2, XCircle } from 'lucide-react';
import React from 'react';

import {
  closeMcpConnection,
  getMcpStatus,
  listMcpApprovals,
  listMcpClients,
  listMcpConnections,
  revokeMcpPairingToken,
  rotateMcpPairingToken,
} from '../../lib/backend';
import { useDateTimeFormatter } from '../../lib/date-time-format';
import { t } from '../../lib/i18n';
import { setMcpApprovals, setMcpClients, setMcpConnections, setMcpStatus, useMcpStore } from '../../lib/mcp-store';
import { useSettingsValue } from '../../lib/settings-store';
import { useToast } from '../../lib/toast-context';
import { Button } from '../ui/button';
import { FormSectionHeading } from '../ui/form';
import { formStyles } from '../ui/form-styles';
import { MenuToggleGroup, MenuToggleGroupItem } from '../ui/menubar';

/**
 * Renders an unframed Settings section with an optional action group.
 *
 * Composes the shared settings form styles (`FormSectionHeading`,
 * `formStyles.helperText`) so the MCP surface tracks the standard Settings
 * visual language automatically when those tokens evolve.
 *
 * @param props Section heading, actions, and content.
 * @returns Settings section element.
 */
const ManagementSection: React.FC<{
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, actions, children }) => (
  <section className="grid gap-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-1">
        <FormSectionHeading>{title}</FormSectionHeading>
        {description ? <p className={formStyles.helperText}>{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 px-2.5">{actions}</div> : null}
    </div>
    <div className="grid gap-3 px-2.5">{children}</div>
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
    <span className="text-xs text-form-text-muted">{label}</span>
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-form-control px-2.5 py-2 font-mono text-xs text-form-text">
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

/** Server key advertised to external MCP clients. */
const MCP_SERVER_KEY = 'cosmosh';

type ClientConfigVariant = 'claudeCode' | 'claudeDesktop' | 'raw';

/**
 * Builds a paste-ready client-config snippet for a launcher-based bridge.
 *
 * All JSON-based clients (Claude Code `.mcp.json`, Claude Desktop
 * `claude_desktop_config.json`, Cursor) share the `mcpServers` shape; the
 * launcher script already pins `--discovery`, so no args or env are required.
 * The raw variant lists the command/args/env fields for form-based clients.
 *
 * @param variant Selected config flavour.
 * @param launcherPath Absolute launcher-script path.
 * @returns Snippet text to display and copy.
 */
const buildClientConfig = (variant: ClientConfigVariant, launcherPath: string): string => {
  if (variant === 'raw') {
    return [`command: ${launcherPath}`, 'args: (none)', 'env: (none)'].join('\n');
  }

  return `${JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_KEY]: {
          command: launcherPath,
        },
      },
    },
    null,
    2,
  )}\n`;
};

/**
 * Renders the client-configuration section: a variant selector plus a paste-ready
 * snippet, or a development-mode notice when no packaged launcher exists.
 *
 * @param props Launcher/discovery paths and the copy handler.
 * @returns Client-config section element.
 */
const ClientConfigSection: React.FC<{
  launcherPath: string | undefined;
  discoveryFilePath: string | undefined;
  onCopy: (value: string) => void;
}> = ({ launcherPath, discoveryFilePath, onCopy }) => {
  const [variant, setVariant] = React.useState<ClientConfigVariant>('claudeCode');

  const variants: readonly { id: ClientConfigVariant; label: string }[] = [
    { id: 'claudeCode', label: t('mcp.config.variantClaudeCode') },
    { id: 'claudeDesktop', label: t('mcp.config.variantClaudeDesktop') },
    { id: 'raw', label: t('mcp.config.variantRaw') },
  ];

  return (
    <ManagementSection
      title={t('mcp.config.title')}
      description={t('mcp.config.description')}
    >
      {launcherPath ? (
        <div className="grid gap-3">
          <div>
            <MenuToggleGroup
              type="single"
              value={variant}
              aria-label={t('mcp.config.title')}
              onValueChange={(value) => {
                // Radix emits an empty value when the active item is clicked;
                // keep the current selection so a snippet is always shown.
                if (value) {
                  setVariant(value as ClientConfigVariant);
                }
              }}
            >
              {variants.map((entry) => (
                <MenuToggleGroupItem
                  key={entry.id}
                  value={entry.id}
                >
                  {entry.label}
                </MenuToggleGroupItem>
              ))}
            </MenuToggleGroup>
          </div>
          <p className="text-xs text-form-text-muted">
            {variant === 'claudeCode'
              ? t('mcp.config.hintClaudeCode')
              : variant === 'claudeDesktop'
                ? t('mcp.config.hintClaudeDesktop')
                : t('mcp.config.hintRaw')}
          </p>
          <div className="relative">
            <pre className="max-h-64 overflow-auto rounded-lg bg-bg-subtle p-3 pr-11 font-mono text-xs text-form-text">
              {buildClientConfig(variant, launcherPath)}
            </pre>
            <Button
              variant="ghostIcon"
              aria-label={t('mcp.actions.copy')}
              className="absolute right-2 top-2"
              onClick={() => onCopy(buildClientConfig(variant, launcherPath))}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-form-text-muted">{t('mcp.config.devNotice')}</p>
          {discoveryFilePath ? (
            <CopyableRow
              label={t('mcp.config.devDiscoveryLabel')}
              value={`COSMOSH_MCP_DISCOVERY=${discoveryFilePath}`}
              onCopy={onCopy}
            />
          ) : null}
        </div>
      )}
    </ManagementSection>
  );
};

/**
 * Settings-owned MCP management section for pairing tokens,
 * connected clients, active SSH connections, and pending approvals.
 *
 * The reactive lists are backed by the shared MCP store, which the global
 * approval host keeps live through the backend event channel (streaming
 * status/approval/connection/client events and refetching on reconnect).
 * This section therefore only primes the store on mount and after its own
 * management actions (token rotation/revocation, connection close) — no
 * manual refresh control is needed.
 *
 * @returns MCP management content for the Settings surface.
 */
const SettingsMcpSection: React.FC = () => {
  const mcpEnabled = useSettingsValue('mcpEnabled');
  const { status, clients, connections, approvals } = useMcpStore();
  const { formatDateTime } = useDateTimeFormatter();
  const { success: notifySuccess, error: notifyError } = useToast();

  const [rotating, setRotating] = React.useState<boolean>(false);
  const [revoking, setRevoking] = React.useState<boolean>(false);
  const [closingId, setClosingId] = React.useState<string | null>(null);
  const [freshToken, setFreshToken] = React.useState<string | null>(null);

  const refreshAll = React.useCallback(async (): Promise<void> => {
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

  // Hide the whole management surface while MCP access is turned off; the
  // category already exposes the enable switch above this section.
  if (!mcpEnabled) {
    return null;
  }

  return (
    <div className="grid gap-8 pb-4">
      <ManagementSection
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
              {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('mcp.token.revoke')}
            </Button>
            <Button
              variant="inverted"
              disabled={rotating}
              onClick={() => {
                void handleRotateToken();
              }}
            >
              {rotating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('mcp.token.rotate')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="flex items-center gap-2 text-sm text-form-text">
            <KeyRound className="h-4 w-4 text-form-text-muted" />
            {status?.tokenConfigured ? t('mcp.token.configured') : t('mcp.token.notConfigured')}
          </div>
          {freshToken ? (
            <div className="grid gap-2 rounded-lg border border-home-divider p-3">
              <p className="text-xs text-form-text-muted">{t('mcp.token.freshNotice')}</p>
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
      </ManagementSection>

      <ClientConfigSection
        launcherPath={status?.bridgeLauncherPath}
        discoveryFilePath={status?.discoveryFilePath}
        onCopy={handleCopy}
      />

      <ManagementSection title={t('mcp.clients.title')}>
        <McpClientList
          clients={clients}
          formatDateTime={formatDateTime}
        />
      </ManagementSection>

      <ManagementSection title={t('mcp.connections.title')}>
        <McpConnectionList
          connections={connections}
          closingId={closingId}
          formatDateTime={formatDateTime}
          onClose={(connectionId) => {
            void handleCloseConnection(connectionId);
          }}
        />
      </ManagementSection>

      <ManagementSection title={t('mcp.approvals.title')}>
        <McpApprovalList
          approvals={approvals}
          formatDateTime={formatDateTime}
        />
      </ManagementSection>
    </div>
  );
};

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
    return <p className="text-sm text-form-text-muted">{t('mcp.clients.empty')}</p>;
  }

  return (
    <ul className="grid gap-2">
      {clients.map((client) => (
        <li
          key={client.mcpSessionId}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-form-control px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-form-text-muted" />
            <span className="text-sm text-form-text">
              {client.client.name} {client.client.version}
            </span>
          </div>
          <span className="text-xs text-form-text-muted">
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
    return <p className="text-sm text-form-text-muted">{t('mcp.connections.empty')}</p>;
  }

  return (
    <ul className="grid gap-2">
      {connections.map((connection) => (
        <li
          key={connection.connectionId}
          className="grid gap-2 rounded-lg bg-form-control px-3 py-2"
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-form-text-muted">
            <span>
              {connection.username}@{connection.host}:{connection.port}
            </span>
            <span>{t('mcp.connections.commandCount', { count: String(connection.commandCount) })}</span>
            <span>{t(`mcp.connections.mode.${connection.mode}`)}</span>
            <span>{t(`mcp.connections.status.${connection.status}`)}</span>
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
    return <p className="text-sm text-form-text-muted">{t('mcp.approvals.empty')}</p>;
  }

  return (
    <ul className="grid gap-2">
      {approvals.map((approval) => (
        <li
          key={approval.approvalId}
          className="grid gap-1 rounded-lg bg-form-control px-3 py-2"
        >
          <div className="flex items-center gap-2">
            {approval.kind === 'command-execute' ? (
              <Plug className="h-4 w-4 text-form-text-muted" />
            ) : (
              <XCircle className="h-4 w-4 text-form-text-muted" />
            )}
            <span className="text-sm text-form-text">
              {approval.kind === 'command-execute'
                ? t('mcp.approvals.kindCommand')
                : approval.kind === 'terminal-attach'
                  ? t('mcp.approvals.kindAttach')
                  : t('mcp.approvals.kindConnection')}
            </span>
          </div>
          <div className="text-xs text-form-text-muted">
            {approval.client.name}
            {approval.serverName ? ` · ${approval.serverName}` : ''} · {formatDateTime(approval.createdAt)}
          </div>
          {approval.command ? (
            <code className="truncate rounded-lg bg-bg-subtle px-2.5 py-2 font-mono text-xs text-form-text">
              {approval.command}
            </code>
          ) : null}
        </li>
      ))}
    </ul>
  );
};

export default SettingsMcpSection;
