import type { ApiMcpPendingApproval, ApiMcpResolveApprovalRequest } from '@cosmosh/api-contract';
import React from 'react';

import { useMcpEvents } from '../hooks/use-mcp-events';
import {
  type AgentTerminalDisabledReason,
  resolveDefaultAgentTerminalSurface,
  useAgentTerminalSurfaces,
} from '../lib/agent-terminal-registry';
import { resolveMcpApproval } from '../lib/backend';
import { t } from '../lib/i18n';
import { setMcpApprovals, useMcpStoreSelector } from '../lib/mcp-store';
import { useToast } from '../lib/toast-context';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

type ApprovalDecision = ApiMcpResolveApprovalRequest['decision'];

/**
 * Computes the whole-second countdown remaining until an approval expires.
 *
 * @param expiresAt ISO-8601 expiry timestamp.
 * @param now Current epoch milliseconds.
 * @returns Non-negative seconds remaining.
 */
const computeSecondsRemaining = (expiresAt: string, now: number): number => {
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) {
    return 0;
  }
  return Math.max(0, Math.ceil((expiryMs - now) / 1000));
};

type ApprovalDetailRowProps = {
  label: string;
  value: string;
};

/**
 * Renders one label/value row inside the approval dialog details block.
 *
 * @param props Row label and value.
 * @returns Details row element.
 */
const ApprovalDetailRow: React.FC<ApprovalDetailRowProps> = ({ label, value }) => (
  <div className="grid grid-cols-[110px_1fr] gap-2 text-sm">
    <span className="text-header-text-muted">{label}</span>
    <span className="break-words text-form-text">{value}</span>
  </div>
);

type ApprovalDialogBodyProps = {
  approval: ApiMcpPendingApproval;
  queueLength: number;
  submitting: boolean;
  terminalSurfaces: ReturnType<typeof useAgentTerminalSurfaces>;
  selectedSurfaceId: string | null;
  onSelectedSurfaceIdChange: (surfaceId: string) => void;
  onResolve: (decision: ApprovalDecision, terminalSessionId?: string) => void;
};

/**
 * Maps a stable terminal disable reason to user-facing approval copy.
 *
 * @param reason Stable pane eligibility reason.
 * @returns Localized reason.
 */
const resolveDisabledReasonLabel = (reason: AgentTerminalDisabledReason): string => {
  return t(`mcpApproval.attach.disabledReasons.${reason}`);
};

/**
 * Renders the details and actions for the currently-focused pending approval.
 *
 * @param props Approval payload, queue position, and resolution callbacks.
 * @returns Approval dialog body.
 */
const ApprovalDialogBody: React.FC<ApprovalDialogBodyProps> = ({
  approval,
  queueLength,
  submitting,
  terminalSurfaces,
  selectedSurfaceId,
  onSelectedSurfaceIdChange,
  onResolve,
}) => {
  const [secondsRemaining, setSecondsRemaining] = React.useState<number>(() =>
    computeSecondsRemaining(approval.expiresAt, Date.now()),
  );

  React.useEffect(() => {
    setSecondsRemaining(computeSecondsRemaining(approval.expiresAt, Date.now()));
    const interval = setInterval(() => {
      setSecondsRemaining(computeSecondsRemaining(approval.expiresAt, Date.now()));
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [approval.expiresAt, approval.approvalId]);

  const isServerList = approval.kind === 'server-list';
  const isCommand = approval.kind === 'command-execute';
  const isTerminalAttach = approval.kind === 'terminal-attach';
  const title = isServerList
    ? t('mcpApproval.serverList.title')
    : isCommand
      ? t('mcpApproval.command.title')
      : isTerminalAttach
        ? t('mcpApproval.attach.title')
        : t('mcpApproval.connection.title');
  const description = isServerList
    ? t('mcpApproval.serverList.description')
    : isCommand
      ? t('mcpApproval.command.description')
      : isTerminalAttach
        ? t('mcpApproval.attach.description')
        : t('mcpApproval.connection.description');
  const clientLabel = `${approval.client.name} ${approval.client.version}`.trim();
  const serverTarget = approval.host && approval.port !== undefined ? `${approval.host}:${approval.port}` : null;
  const selectedSurface = terminalSurfaces.find((surface) => surface.surfaceId === selectedSurfaceId) ?? null;
  const selectedTerminalEligible = selectedSurface?.disabledReason === null && selectedSurface.sessionId !== null;

  return (
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <ApprovalDetailRow
          label={t('mcpApproval.fields.client')}
          value={clientLabel}
        />
        {approval.serverName ? (
          <ApprovalDetailRow
            label={t('mcpApproval.fields.server')}
            value={approval.serverName}
          />
        ) : null}
        {serverTarget ? (
          <ApprovalDetailRow
            label={t('mcpApproval.fields.target')}
            value={serverTarget}
          />
        ) : null}
        {approval.username ? (
          <ApprovalDetailRow
            label={t('mcpApproval.fields.username')}
            value={approval.username}
          />
        ) : null}
        {approval.reason ? (
          <ApprovalDetailRow
            label={t('mcpApproval.fields.reason')}
            value={approval.reason}
          />
        ) : null}
        {isCommand && approval.command ? (
          <div className="grid gap-1">
            <span className="text-sm text-header-text-muted">{t('mcpApproval.fields.command')}</span>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-black/20 p-2 font-mono text-xs text-form-text">
              {approval.command}
            </pre>
          </div>
        ) : null}
        {isTerminalAttach ? (
          <div className="grid gap-1.5">
            <label
              htmlFor="mcp-approval-terminal"
              className="text-sm text-header-text-muted"
            >
              {t('mcpApproval.fields.terminal')}
            </label>
            {terminalSurfaces.length > 0 ? (
              <Select
                value={selectedSurfaceId ?? undefined}
                onValueChange={onSelectedSurfaceIdChange}
              >
                <SelectTrigger id="mcp-approval-terminal">
                  <SelectValue placeholder={t('mcpApproval.attach.selectTerminal')} />
                </SelectTrigger>
                <SelectContent>
                  {terminalSurfaces.map((surface) => {
                    const paneLabel = t('mcpApproval.attach.paneLabel', {
                      tab: surface.tabTitle,
                      pane: String(surface.paneIndex + 1),
                    });
                    return (
                      <SelectItem
                        key={surface.surfaceId}
                        value={surface.surfaceId}
                        disabled={surface.disabledReason !== null || surface.sessionId === null}
                      >
                        {surface.disabledReason
                          ? `${paneLabel} · ${resolveDisabledReasonLabel(surface.disabledReason)}`
                          : paneLabel}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-md border border-home-divider px-3 py-2 text-sm text-header-text-muted">
                {t('mcpApproval.attach.noTerminals')}
              </div>
            )}
            {selectedSurface?.disabledReason ? (
              <span className="text-xs text-header-text-muted">
                {resolveDisabledReasonLabel(selectedSurface.disabledReason)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between text-xs text-header-text-muted">
        <span>{queueLength > 1 ? t('mcpApproval.queue.remaining', { count: String(queueLength) }) : ''}</span>
        <span>{t('mcpApproval.queue.expiresIn', { seconds: String(secondsRemaining) })}</span>
      </div>

      <DialogFooter>
        <DialogSecondaryButton
          disabled={submitting}
          onClick={() => onResolve('denied')}
        >
          {t('mcpApproval.actions.deny')}
        </DialogSecondaryButton>
        {isCommand ? (
          <DialogSecondaryButton
            disabled={submitting}
            onClick={() => onResolve('approvedForConnection')}
          >
            {t('mcpApproval.actions.approveForConnection')}
          </DialogSecondaryButton>
        ) : null}
        <DialogPrimaryButton
          autoFocus
          disabled={submitting || (isTerminalAttach && !selectedTerminalEligible)}
          onClick={() =>
            onResolve('approved', isTerminalAttach ? (selectedSurface?.sessionId ?? undefined) : undefined)
          }
        >
          {t('mcpApproval.actions.approve')}
        </DialogPrimaryButton>
      </DialogFooter>
    </DialogContent>
  );
};

/**
 * Global host that keeps the MCP event channel live and surfaces pending
 * authorization requests as a queued modal dialog.
 *
 * Mounted once at the app root (alongside the close-window confirmation). The
 * oldest pending approval is shown first; resolving it advances to the next.
 *
 * @returns Approval dialog host.
 */
const McpApprovalHost: React.FC = () => {
  useMcpEvents();

  const approvals = useMcpStoreSelector((snapshot) => snapshot.approvals);
  const terminalSurfaces = useAgentTerminalSurfaces();
  const { error: notifyError } = useToast();
  const [submittingId, setSubmittingId] = React.useState<string | null>(null);
  const [selectedSurfaceId, setSelectedSurfaceId] = React.useState<string | null>(null);
  const selectedApprovalIdRef = React.useRef<string | null>(null);

  const currentApproval = approvals.length > 0 ? approvals[0] : null;

  React.useEffect(() => {
    if (currentApproval?.kind !== 'terminal-attach') {
      selectedApprovalIdRef.current = currentApproval?.approvalId ?? null;
      setSelectedSurfaceId(null);
      return;
    }

    setSelectedSurfaceId((current) => {
      if (selectedApprovalIdRef.current !== currentApproval.approvalId) {
        selectedApprovalIdRef.current = currentApproval.approvalId;
        return resolveDefaultAgentTerminalSurface(terminalSurfaces)?.surfaceId ?? null;
      }
      if (current && terminalSurfaces.some((surface) => surface.surfaceId === current)) {
        return current;
      }
      return resolveDefaultAgentTerminalSurface(terminalSurfaces)?.surfaceId ?? null;
    });
  }, [currentApproval?.approvalId, currentApproval?.kind, terminalSurfaces]);

  // Pull the window forward whenever a fresh approval becomes the active one.
  const focusedApprovalIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!currentApproval) {
      focusedApprovalIdRef.current = null;
      return;
    }
    if (focusedApprovalIdRef.current === currentApproval.approvalId) {
      return;
    }
    focusedApprovalIdRef.current = currentApproval.approvalId;
    void window.electron?.focusWindow?.();
  }, [currentApproval]);

  const handleResolve = React.useCallback(
    async (decision: ApprovalDecision, terminalSessionId?: string): Promise<void> => {
      if (!currentApproval) {
        return;
      }
      const { approvalId } = currentApproval;
      setSubmittingId(approvalId);
      try {
        await resolveMcpApproval(approvalId, {
          decision,
          ...(decision !== 'denied' && terminalSessionId ? { terminalSessionId } : {}),
        });
        // The event-channel resolution is idempotent with this immediate UI update.
        setMcpApprovals(approvals.filter((item) => item.approvalId !== approvalId));
      } catch {
        notifyError(t('mcpApproval.errors.resolveFailed'));
      } finally {
        setSubmittingId((previous) => (previous === approvalId ? null : previous));
      }
    },
    [approvals, currentApproval, notifyError],
  );

  return (
    <Dialog
      open={currentApproval !== null}
      onOpenChange={(nextOpen) => {
        // Deny on dismissal (Escape / overlay) to avoid leaving the agent hanging.
        if (!nextOpen && currentApproval && submittingId !== currentApproval.approvalId) {
          void handleResolve('denied');
        }
      }}
    >
      {currentApproval ? (
        <ApprovalDialogBody
          approval={currentApproval}
          queueLength={approvals.length}
          submitting={submittingId === currentApproval.approvalId}
          terminalSurfaces={terminalSurfaces}
          selectedSurfaceId={selectedSurfaceId}
          onSelectedSurfaceIdChange={setSelectedSurfaceId}
          onResolve={(decision, terminalSessionId) => {
            void handleResolve(decision, terminalSessionId);
          }}
        />
      ) : null}
    </Dialog>
  );
};

export default McpApprovalHost;
