import type { TerminalCredentialFillOffer, TerminalCredentialFillResult } from '@cosmosh/api-contract';
import { KeyRound } from 'lucide-react';
import React from 'react';

import { t } from '../../lib/i18n';
import { Button } from '../ui/button';
import { menuStyles } from '../ui/menu-styles';

/** Non-secret state for a credential action bound to one visible terminal pane. */
type TerminalCredentialFillProps = {
  offer: TerminalCredentialFillOffer | null;
  pending: boolean;
  result: { payload: TerminalCredentialFillResult; receivedAt: number } | null;
  onFill: (token: string) => void;
};

/**
 * Presents an explicit saved-login-password action, independently of completion.
 *
 * @param props Current prompt offer, transient result and backend request callback.
 * @returns Action or brief status text; never renders or receives the credential.
 */
export const TerminalCredentialFill = ({
  offer,
  pending,
  result,
  onFill,
}: TerminalCredentialFillProps): React.ReactNode => {
  const [, refreshExpiry] = React.useReducer((value: number) => value + 1, 0);
  const deadline = offer?.expiresAt ?? (result ? result.receivedAt + 4_000 : 0);
  React.useEffect(() => {
    if (!deadline) return;
    const timer = window.setTimeout(refreshExpiry, Math.max(0, deadline - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [deadline]);
  if (!deadline || deadline <= Date.now()) return null;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-40 flex justify-end">
      {offer ? (
        <Button
          className="pointer-events-auto max-w-full"
          disabled={pending}
          title={t('ssh.credentialFill.hint')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onFill(offer.token)}
        >
          <KeyRound className="h-4 w-4 shrink-0" />
          <span className="truncate">{t(pending ? 'ssh.credentialFill.pending' : 'ssh.credentialFill.action')}</span>
        </Button>
      ) : result ? (
        <div
          className={menuStyles.content}
          role="status"
        >
          {result.payload.status === 'filled'
            ? t('ssh.credentialFill.filled')
            : t(`ssh.credentialFill.rejected.${result.payload.reason}`)}
        </div>
      ) : null}
    </div>
  );
};
