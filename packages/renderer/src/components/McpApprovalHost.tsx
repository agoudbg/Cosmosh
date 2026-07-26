import type { ApiMcpPendingApproval, ApiMcpResolveApprovalRequest } from '@cosmosh/api-contract';
import React from 'react';

import { useMcpEvents } from '../hooks/use-mcp-events';
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
  onResolve: (decision: ApprovalDecision) => void;
};

/**
 * Renders the details and actions for the currently-focused pending approval.
 *
 * @param props Approval payload, queue position, and resolution callbacks.
 * @returns Approval dialog body.
 */
const ApprovalDialogBody: React.FC<ApprovalDialogBodyProps> = ({ approval, queueLength, submitting, onResolve }) => {
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

  const isCommand = approval.kind === 'command-execute';
  const title = isCommand ? t('mcpApproval.command.title') : t('mcpApproval.connection.title');
  const description = isCommand ? t('mcpApproval.command.description') : t('mcpApproval.connection.description');
  const clientLabel = `${approval.client.name} ${approval.client.version}`.trim();
  const serverTarget = `${approval.host}:${approval.port}`;

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
        <ApprovalDetailRow
          label={t('mcpApproval.fields.server')}
          value={approval.serverName}
        />
        <ApprovalDetailRow
          label={t('mcpApproval.fields.target')}
          value={serverTarget}
        />
        <ApprovalDetailRow
          label={t('mcpApproval.fields.username')}
          value={approval.username}
        />
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
          disabled={submitting}
          onClick={() => onResolve('approved')}
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
  const { error: notifyError } = useToast();
  const [submittingId, setSubmittingId] = React.useState<string | null>(null);

  const currentApproval = approvals.length > 0 ? approvals[0] : null;

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
    async (decision: ApprovalDecision): Promise<void> => {
      if (!currentApproval) {
        return;
      }
      const { approvalId } = currentApproval;
      setSubmittingId(approvalId);
      try {
        await resolveMcpApproval(approvalId, { decision } as ApiMcpResolveApprovalRequest);
      } catch {
        notifyError(t('mcpApproval.errors.resolveFailed'));
      } finally {
        // Optimistically drop it locally; the backend event is idempotent.
        setMcpApprovals(approvals.filter((item) => item.approvalId !== approvalId));
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
          onResolve={(decision) => {
            void handleResolve(decision);
          }}
        />
      ) : null}
    </Dialog>
  );
};

export default McpApprovalHost;
