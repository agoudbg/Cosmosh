import type { ApiSftpEntry, SftpAuxiliarySidebarMode } from '@cosmosh/api-contract';
import { AlertTriangle, Code2, File, Image, Info } from 'lucide-react';
import React from 'react';

import { Button } from '../../components/ui/button';
import { SurfaceSkeleton } from '../../components/ui/skeleton';
import { useDateTimeFormatter } from '../../lib/date-time-format';
import { t } from '../../lib/i18n';
import { SFTP_CARD_CLASS_NAME } from './sftp-constants';
import type { SftpLargePreviewPrompt, SftpPreviewState } from './sftp-types';
import { formatFileSize, formatModifiedAt, resolveEntryIcon } from './sftp-utils';
import type { SftpCodeMirrorPreviewEditorProps } from './SftpCodeMirrorPreviewEditor';

const SftpCodeMirrorPreviewEditor = React.lazy(() => import('./SftpCodeMirrorPreviewEditor'));

type SftpPreviewEditorErrorBoundaryProps = React.PropsWithChildren<{
  fallback: React.ReactNode;
}>;

type SftpPreviewEditorErrorBoundaryState = {
  hasError: boolean;
};

/**
 * Keeps editor loading failures scoped to the preview panel instead of the full SFTP page.
 */
class SftpPreviewEditorErrorBoundary extends React.Component<
  SftpPreviewEditorErrorBoundaryProps,
  SftpPreviewEditorErrorBoundaryState
> {
  state: SftpPreviewEditorErrorBoundaryState = { hasError: false };

  /**
   * Switches the boundary to its fallback UI after a child render failure.
   *
   * @returns Error boundary state.
   */
  static getDerivedStateFromError(): SftpPreviewEditorErrorBoundaryState {
    return { hasError: true };
  }

  /**
   * Renders either the preview editor children or the scoped fallback.
   *
   * @returns React node for the boundary content.
   */
  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}

/**
 * Props for the right-side SFTP details panel.
 */
type SftpDetailPanelProps = {
  auxiliarySidebarMode: Exclude<SftpAuxiliarySidebarMode, 'off'>;
  previewState: SftpPreviewState | null;
  selectedCount: number;
  selectedEntry: ApiSftpEntry | null;
  onConfirmLargePreview: (prompt: SftpLargePreviewPrompt) => void;
  onPreviewContentChange: (content: string) => void;
  onPreviewEditorMount: SftpCodeMirrorPreviewEditorProps['onMount'];
  onPreviewSave: () => Promise<void>;
};

/**
 * Renders selected-entry details and file previews.
 *
 * @param props Selected entry and preview state.
 * @returns SFTP details panel.
 */
export const SftpDetailPanel: React.FC<SftpDetailPanelProps> = ({
  auxiliarySidebarMode,
  onConfirmLargePreview,
  onPreviewContentChange,
  onPreviewEditorMount,
  onPreviewSave,
  previewState,
  selectedCount,
  selectedEntry,
}) => {
  const { formatDateTime } = useDateTimeFormatter();

  const renderDetails = (): React.ReactNode => {
    if (selectedCount > 1) {
      return (
        <div className="space-y-3">
          <div className="text-sm text-home-text-subtle">{t('sftp.detailSelectedMany', { count: selectedCount })}</div>
        </div>
      );
    }

    if (!selectedEntry) {
      return (
        <div className="flex h-full items-center justify-center px-3 text-center text-sm text-home-text-subtle">
          {t('sftp.detailEmpty')}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex min-w-0 items-center gap-2">
          {resolveEntryIcon(selectedEntry)}
          <div className="min-w-0">
            <div className="text-home-text truncate text-sm font-medium">{selectedEntry.name}</div>
            <div className="mt-0.5 text-xs text-home-text-subtle">{t(`sftp.entryType.${selectedEntry.type}`)}</div>
          </div>
        </div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-home-text-subtle">{t('sftp.detail.path')}</dt>
            <dd className="text-home-text mt-1 break-all font-mono text-xs">{selectedEntry.path}</dd>
          </div>
          <div>
            <dt className="text-xs text-home-text-subtle">{t('sftp.detail.size')}</dt>
            <dd className="text-home-text mt-1">{formatFileSize(selectedEntry.size)}</dd>
          </div>
          <div>
            <dt className="text-xs text-home-text-subtle">{t('sftp.detail.modified')}</dt>
            <dd className="text-home-text mt-1">{formatModifiedAt(selectedEntry.modifiedAt, formatDateTime)}</dd>
          </div>
          <div>
            <dt className="text-xs text-home-text-subtle">{t('sftp.detail.permissions')}</dt>
            <dd className="text-home-text mt-1 font-mono text-xs">{selectedEntry.permissions}</dd>
          </div>
        </dl>
      </div>
    );
  };

  const renderPreviewHeader = (entry: ApiSftpEntry, icon: React.ReactNode, detail?: string): React.ReactNode => (
    <div className="flex min-w-0 items-center gap-2">
      {icon}
      <div className="min-w-0">
        <div className="text-home-text truncate text-sm font-medium">{entry.name}</div>
        <div className="mt-0.5 text-xs text-home-text-subtle">{detail ?? formatFileSize(entry.size)}</div>
      </div>
    </div>
  );

  const renderNoPreview = (message = t('sftp.previewNoPreview')): React.ReactNode => (
    <div className="flex h-full items-center justify-center px-3 text-center text-sm text-home-text-subtle">
      {message}
    </div>
  );

  const renderEditorLoading = (): React.ReactNode => (
    <div
      className="flex h-full flex-col gap-2 px-3 pt-3"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">{t('sftp.previewLoading')}</span>
      <div
        aria-hidden="true"
        className="space-y-2.5"
      >
        <SurfaceSkeleton className="h-3 w-2/3" />
        <SurfaceSkeleton className="h-3 w-full" />
        <SurfaceSkeleton className="h-3 w-5/6" />
        <SurfaceSkeleton className="h-3 w-3/4" />
        <SurfaceSkeleton className="h-3 w-1/2" />
      </div>
    </div>
  );

  const renderPreview = (): React.ReactNode => {
    if (!previewState) {
      return renderNoPreview(t(selectedCount > 1 ? 'sftp.previewSelectOne' : 'sftp.previewEmptySelection'));
    }

    if (previewState.status === 'loading') {
      return (
        <div
          className="flex h-full min-h-0 flex-col gap-2"
          role="status"
          aria-busy="true"
        >
          <span className="sr-only">{t('sftp.previewLoading')}</span>
          <div
            aria-hidden="true"
            className="flex min-w-0 items-center gap-2"
          >
            <SurfaceSkeleton className="h-4 w-4 shrink-0 rounded-sm-2" />
            <div className="min-w-0 flex-1">
              <SurfaceSkeleton className="h-3.5 w-1/2" />
              <SurfaceSkeleton className="mt-1.5 h-2.5 w-1/4" />
            </div>
          </div>
          <SurfaceSkeleton className="-mx-2 -mb-2 min-h-0 flex-1 rounded-lg" />
        </div>
      );
    }

    if (previewState.status === 'large-file') {
      const { entry, previewType, thresholdBytes } = previewState.prompt;
      return (
        <div className="flex h-full min-h-0 flex-col gap-3">
          {renderPreviewHeader(entry, <AlertTriangle className="text-home-text h-4 w-4 shrink-0" />)}
          <div className="bg-home-card/70 rounded-lg border border-home-divider p-3 text-sm text-home-text-subtle">
            {t(previewType === 'image' ? 'sftp.previewLargeImage' : 'sftp.previewLargeText', {
              size: formatFileSize(entry.size),
              threshold: formatFileSize(thresholdBytes),
            })}
          </div>
          <Button
            className="self-start"
            padding="mid"
            onClick={() => onConfirmLargePreview(previewState.prompt)}
          >
            {t('sftp.previewOpenAnyway')}
          </Button>
        </div>
      );
    }

    if (previewState.status === 'unsupported') {
      return renderNoPreview();
    }

    if (previewState.status === 'error') {
      return renderNoPreview(previewState.message);
    }

    if (previewState.status === 'image') {
      return (
        <div className="flex h-full min-h-0 flex-col gap-2">
          {renderPreviewHeader(previewState.entry, <Image className="text-home-text h-4 w-4 shrink-0" />)}
          <div
            data-input-context-menu-ignore="true"
            className="bg-home-card/70 -mx-2 -mb-2 flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg"
          >
            <img
              alt={previewState.entry.name}
              className="max-h-full max-w-full object-contain"
              src={previewState.sourceDataUrl}
            />
          </div>
        </div>
      );
    }

    const isDirty = previewState.content !== previewState.savedContent;
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        {renderPreviewHeader(
          previewState.entry,
          <Code2 className="text-home-text h-4 w-4 shrink-0" />,
          isDirty ? t('sftp.previewModified') : formatFileSize(previewState.entry.size),
        )}
        <div
          data-input-context-menu-ignore="true"
          className="-mx-2 -mb-2 min-h-0 flex-1 overflow-hidden"
        >
          <SftpPreviewEditorErrorBoundary
            key={previewState.entry.path}
            fallback={renderNoPreview(t('sftp.previewFailed'))}
          >
            <React.Suspense fallback={renderEditorLoading()}>
              <SftpCodeMirrorPreviewEditor
                language={previewState.language}
                readOnly={previewState.isSaving}
                value={previewState.content}
                onChange={onPreviewContentChange}
                onMount={onPreviewEditorMount}
                onSave={onPreviewSave}
              />
            </React.Suspense>
          </SftpPreviewEditorErrorBoundary>
        </div>
      </div>
    );
  };

  return (
    <aside className={SFTP_CARD_CLASS_NAME}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-[34px] shrink-0 items-center gap-2 px-2">
          {auxiliarySidebarMode === 'preview' ? (
            <File className="h-4 w-4 shrink-0 text-home-text-subtle" />
          ) : (
            <Info className="h-4 w-4 shrink-0 text-home-text-subtle" />
          )}
          <div className="text-home-text min-w-0 flex-1 truncate text-sm font-medium">
            {auxiliarySidebarMode === 'preview' ? t('sftp.previewTitle') : t('sftp.detailTitle')}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {auxiliarySidebarMode === 'preview' ? renderPreview() : renderDetails()}
        </div>
      </div>
    </aside>
  );
};
