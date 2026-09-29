import classNames from 'classnames';
import { ChevronRight, Sparkles } from 'lucide-react';
import React from 'react';

import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSecondaryButton,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog';
import { dialogStyles } from '../../components/ui/dialog-styles';
import { t } from '../../lib/i18n';
import { type EnhancementStatusInput, resolveEnhancementStatus } from './remote-enhancement-status';

/** Read-only status for the active SSH pane. The owner remounts this small dialog when its pane changes. */
type RemoteEnhancementsStatusProps = { input: EnhancementStatusInput; paneNumber: number };

/**
 * Provides a discoverable plain-language view without enabling debug logs or querying remote state.
 * @param props Current pane observations, live settings and visible pane number.
 * @returns Sidebar action and a keyboard-accessible, height-bounded status dialog.
 */
export const RemoteEnhancementsStatus: React.FC<RemoteEnhancementsStatusProps> = ({ input, paneNumber }) => {
  const status = resolveEnhancementStatus(input);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          className="w-full shrink-0 justify-start gap-2"
          variant="ghost"
        >
          <Sparkles
            className="h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-left">{t('ssh.enhancementStatus.title')}</span>
          <ChevronRight
            className="h-4 w-4 shrink-0"
            aria-hidden="true"
          />
        </Button>
      </DialogTrigger>
      <DialogContent
        className={dialogStyles.tallEditorContent}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{t('ssh.enhancementStatus.title')}</DialogTitle>
          <DialogDescription>{t('ssh.enhancementStatus.description', { index: paneNumber })}</DialogDescription>
        </DialogHeader>
        <div className={classNames(dialogStyles.tallEditorScrollableBody, 'space-y-3')}>
          <p className="text-sm">{t(`ssh.enhancementStatus.reasons.${status.summary}`)}</p>
          <dl className="divide-y divide-home-divider">
            {status.features.map((feature) => (
              <div
                key={feature.id}
                className="py-2"
                data-enhancement-feature={feature.id}
              >
                <dt className="flex items-start justify-between gap-3 text-sm">
                  <span className="font-medium">{t(`ssh.enhancementStatus.features.${feature.id}`)}</span>
                  <span
                    className={classNames(
                      'shrink-0',
                      feature.state === 'available' ? 'text-status-good' : 'text-home-text-subtle',
                    )}
                  >
                    {t(`ssh.enhancementStatus.${feature.allowed ? 'permissionAllowed' : 'permissionDisabled'}`)}
                    {feature.allowed || feature.state !== 'disabled' ? (
                      <> · {t(`ssh.enhancementStatus.states.${feature.state}`)}</>
                    ) : null}
                  </span>
                </dt>
                <dd className="mt-1 text-xs leading-relaxed text-home-text-subtle">
                  {t(`ssh.enhancementStatus.reasons.${feature.reason}`)}
                  {feature.id === 'directory' && status.directory ? (
                    <code className="mt-1 block select-text break-all text-dialog-text">{status.directory}</code>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs leading-relaxed text-home-text-subtle">{t('ssh.enhancementStatus.settingsHint')}</p>
          <p className="text-xs leading-relaxed text-home-text-subtle">{t('ssh.enhancementStatus.fishSupport')}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <DialogSecondaryButton>{t('ssh.enhancementStatus.close')}</DialogSecondaryButton>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
