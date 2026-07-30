import type {
  ApiSftpArchiveCompressionLevel,
  ApiSftpArchiveConflictResolution,
  ApiSftpArchiveFormat,
} from '@cosmosh/api-contract';
import { Archive, CopyPlus, FolderOpen, TriangleAlert } from 'lucide-react';
import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from '../../components/ui/dialog';
import { useDialogExitSnapshot } from '../../components/ui/dialog-lifecycle';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { t } from '../../lib/i18n';
import {
  detectSftpArchiveFormat,
  normalizeSftpArchiveCompressionLevel,
  switchSftpArchiveExtension,
} from './sftp-archive';
import type {
  SftpArchiveCompressionPrompt,
  SftpArchiveConflictPrompt,
  SftpArchiveDestinationPrompt,
} from './useSftpArchiveActions';

type SftpArchiveCompressionDialogProps = {
  prompt: SftpArchiveCompressionPrompt | null;
  onCancel: () => void;
  onSubmit: (input: {
    archiveName: string;
    compressionLevel: ApiSftpArchiveCompressionLevel;
    format: ApiSftpArchiveFormat;
  }) => void;
};

type SftpArchiveDestinationDialogProps = {
  prompt: SftpArchiveDestinationPrompt | null;
  onCancel: () => void;
  onSubmit: (targetDirectoryPath: string) => void;
};

type SftpArchiveConflictDialogProps = {
  prompt: SftpArchiveConflictPrompt | null;
  onResolve: (resolution: ApiSftpArchiveConflictResolution) => Promise<void>;
};

const COMPRESSION_LEVELS: ApiSftpArchiveCompressionLevel[] = ['fast', 'standard', 'maximum'];

/** Returns whether a user-entered archive name contains ASCII control characters. */
const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });

/**
 * Renders the compact archive name, format, and level form.
 *
 * @param props Prompt state and submit handlers.
 * @returns Compression dialog.
 */
export const SftpArchiveCompressionDialog: React.FC<SftpArchiveCompressionDialogProps> = ({
  prompt,
  onCancel,
  onSubmit,
}) => {
  const [exitPrompt, clearExitPrompt] = useDialogExitSnapshot(prompt);
  const activePrompt = prompt ?? exitPrompt;
  const [archiveName, setArchiveName] = React.useState('');
  const [format, setFormat] = React.useState<ApiSftpArchiveFormat>('tar-gzip');
  const [compressionLevel, setCompressionLevel] = React.useState<ApiSftpArchiveCompressionLevel>('standard');

  React.useEffect(() => {
    if (!prompt) return;
    setArchiveName(prompt.initialName);
    setFormat(prompt.initialFormat);
    setCompressionLevel(prompt.initialLevel);
  }, [prompt]);

  const normalizedName = archiveName.trim();
  const selectedCompressionLevel = normalizeSftpArchiveCompressionLevel(format, compressionLevel);
  const hasInvalidName =
    !normalizedName ||
    normalizedName === '.' ||
    normalizedName === '..' ||
    normalizedName.includes('/') ||
    normalizedName.includes('\\') ||
    hasControlCharacters(normalizedName) ||
    detectSftpArchiveFormat(normalizedName) !== format;
  const hasConflict = Boolean(activePrompt?.existingNames.has(normalizedName));
  const canSubmit = Boolean(activePrompt && !hasInvalidName && !hasConflict);

  return (
    <Dialog
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="!max-w-[440px]"
        onExitComplete={clearExitPrompt}
      >
        <DialogHeader>
          <DialogTitle>{t('sftp.archive.compressTitle')}</DialogTitle>
          <DialogDescription>
            {t('sftp.archive.compressDescription', { count: activePrompt?.entries.length ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) {
              onSubmit({
                archiveName: normalizedName,
                format,
                compressionLevel: selectedCompressionLevel,
              });
            }
          }}
        >
          <div className="space-y-1.5">
            <Label
              className="px-0 font-medium !text-form-text"
              htmlFor="sftp-archive-name"
            >
              {t('sftp.archive.nameLabel')}
            </Label>
            <Input
              autoFocus
              id="sftp-archive-name"
              value={archiveName}
              aria-invalid={hasInvalidName || hasConflict}
              onChange={(event) => setArchiveName(event.target.value)}
            />
            {hasConflict ? (
              <div className="text-xs text-form-message-error">{t('sftp.archive.nameConflict')}</div>
            ) : hasInvalidName ? (
              <div className="text-xs text-form-message-error">{t('sftp.archive.nameInvalid')}</div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
            <div className="space-y-1.5">
              <Label
                className="px-0 font-medium !text-form-text"
                htmlFor="sftp-archive-format"
              >
                {t('sftp.archive.formatLabel')}
              </Label>
              <Select
                value={format}
                onValueChange={(value) => {
                  const nextFormat = value as ApiSftpArchiveFormat;
                  setFormat(nextFormat);
                  setArchiveName((previous) => switchSftpArchiveExtension(previous, nextFormat));
                  setCompressionLevel((previous) => normalizeSftpArchiveCompressionLevel(nextFormat, previous));
                }}
              >
                <SelectTrigger id="sftp-archive-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {activePrompt?.supportedFormats.map((supportedFormat) => (
                    <SelectItem
                      key={supportedFormat}
                      value={supportedFormat}
                    >
                      {t(`sftp.archive.format.${supportedFormat}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label
                className="px-0 font-medium !text-form-text"
                htmlFor="sftp-archive-level"
              >
                {t('sftp.archive.levelLabel')}
              </Label>
              <Select
                key={format === 'tar' ? 'store-only' : 'compressed'}
                value={selectedCompressionLevel}
                disabled={format === 'tar'}
                onValueChange={(value) => setCompressionLevel(value as ApiSftpArchiveCompressionLevel)}
              >
                <SelectTrigger id="sftp-archive-level">
                  <SelectValue>{t(`sftp.archive.level.${selectedCompressionLevel}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(format === 'tar' ? ['store'] : COMPRESSION_LEVELS).map((level) => (
                    <SelectItem
                      key={level}
                      value={level}
                    >
                      {t(`sftp.archive.level.${level}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <DialogSecondaryButton
              type="button"
              onClick={onCancel}
            >
              {t('sftp.archive.cancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton
              type="submit"
              disabled={!canSubmit}
            >
              <Archive className="h-4 w-4" />
              {t('sftp.archive.compressAction')}
            </DialogPrimaryButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Renders a compact form for selecting an existing remote extraction directory.
 *
 * @param props Prompt state and submit handlers.
 * @returns Extraction destination dialog.
 */
export const SftpArchiveDestinationDialog: React.FC<SftpArchiveDestinationDialogProps> = ({
  prompt,
  onCancel,
  onSubmit,
}) => {
  const [exitPrompt, clearExitPrompt] = useDialogExitSnapshot(prompt);
  const activePrompt = prompt ?? exitPrompt;
  const [targetDirectoryPath, setTargetDirectoryPath] = React.useState('');

  React.useEffect(() => {
    if (prompt) setTargetDirectoryPath(prompt.initialPath);
  }, [prompt]);

  const normalizedPath = targetDirectoryPath.trim();
  const hasInvalidPath =
    !normalizedPath ||
    normalizedPath === '/' ||
    normalizedPath === '.' ||
    !normalizedPath.startsWith('/') ||
    normalizedPath.includes('\\') ||
    hasControlCharacters(normalizedPath);
  const canSubmit = Boolean(activePrompt && !hasInvalidPath);

  return (
    <Dialog
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="!max-w-[440px]"
        onExitComplete={clearExitPrompt}
      >
        <DialogHeader>
          <DialogTitle>{t('sftp.archive.destinationTitle')}</DialogTitle>
          <DialogDescription>
            {t('sftp.archive.destinationDescription', { count: activePrompt?.entries.length ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit(normalizedPath);
          }}
        >
          <div className="space-y-1.5">
            <Label
              className="px-0 font-medium !text-form-text"
              htmlFor="sftp-archive-destination"
            >
              {t('sftp.archive.destinationLabel')}
            </Label>
            <Input
              autoFocus
              id="sftp-archive-destination"
              value={targetDirectoryPath}
              aria-invalid={hasInvalidPath}
              onChange={(event) => setTargetDirectoryPath(event.target.value)}
            />
            {hasInvalidPath ? (
              <div className="text-xs text-form-message-error">{t('sftp.archive.destinationInvalid')}</div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogSecondaryButton
              type="button"
              onClick={onCancel}
            >
              {t('sftp.archive.cancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton
              type="submit"
              disabled={!canSubmit}
            >
              <FolderOpen className="h-4 w-4" />
              {t('sftp.archive.extractAction')}
            </DialogPrimaryButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Presents one task-wide conflict decision for staged extraction output.
 *
 * @param props Conflict summary and resolution handler.
 * @returns Conflict dialog.
 */
export const SftpArchiveConflictDialog: React.FC<SftpArchiveConflictDialogProps> = ({ prompt, onResolve }) => {
  const [exitPrompt, clearExitPrompt] = useDialogExitSnapshot(prompt);
  const activePrompt = prompt ?? exitPrompt;
  const firstConflict = activePrompt?.conflicts[0];
  const resolvingRef = React.useRef(false);

  React.useEffect(() => {
    if (prompt) resolvingRef.current = false;
  }, [prompt]);

  /** Submits exactly one decision even when closing the dialog emits another open-state event. */
  const handleResolve = React.useCallback(
    (resolution: ApiSftpArchiveConflictResolution): void => {
      if (resolvingRef.current) return;
      resolvingRef.current = true;
      void onResolve(resolution);
    },
    [onResolve],
  );

  return (
    <Dialog
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open) handleResolve('cancel');
      }}
    >
      <DialogContent
        className="!max-w-[480px]"
        onExitComplete={clearExitPrompt}
      >
        <DialogHeader>
          <DialogTitle>{t('sftp.archive.conflictTitle')}</DialogTitle>
          <DialogDescription>
            {t('sftp.archive.conflictDescription', { count: activePrompt?.conflicts.length ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        {firstConflict ? (
          <div className="bg-home-card/70 min-w-0 rounded-md border border-home-divider px-3 py-2">
            <div className="text-home-text truncate text-sm">{firstConflict.path}</div>
            <div className="mt-0.5 truncate text-xs text-home-text-subtle">{firstConflict.targetPath}</div>
          </div>
        ) : null}
        <DialogFooter className="flex-wrap">
          <DialogSecondaryButton onClick={() => handleResolve('cancel')}>
            {t('sftp.archive.cancel')}
          </DialogSecondaryButton>
          <DialogSecondaryButton onClick={() => handleResolve('keep-both')}>
            <CopyPlus className="h-4 w-4" />
            {t('sftp.archive.keepBoth')}
          </DialogSecondaryButton>
          <DialogPrimaryButton onClick={() => handleResolve('overwrite')}>
            <TriangleAlert className="h-4 w-4" />
            {t('sftp.archive.overwrite')}
          </DialogPrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
