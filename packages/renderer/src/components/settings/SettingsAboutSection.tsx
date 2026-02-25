import { Info } from 'lucide-react';
import React from 'react';

import { t } from '../../lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from '../ui/dialog';

export type AppVersionInfo = {
  appName: string;
  version: string;
  buildVersion: string;
  buildTime: string;
  commit: string;
  electron: string;
  chromium: string;
  node: string;
  v8: string;
  os: string;
};

type SettingsAboutSectionProps = {
  appVersionInfo: AppVersionInfo;
  onOpenFailed: (i18nKey: string) => void;
};

const APP_LOGO_URL = new URL('../../assets/logo.svg', import.meta.url).href;

const formatBuildTime = (buildTime: string): string => {
  if (!buildTime) {
    return t('settings.about.buildTimeUnknown');
  }

  const parsed = new Date(buildTime);
  if (Number.isNaN(parsed.getTime())) {
    return t('settings.about.buildTimeUnknown');
  }

  return parsed.toLocaleString();
};

const formatTechnicalValue = (value: string): string => {
  if (value.trim().length === 0) {
    return t('settings.about.technicalInfoUnknown');
  }

  return value;
};

const SettingsAboutSection: React.FC<SettingsAboutSectionProps> = ({ appVersionInfo, onOpenFailed }) => {
  const [iconLoadFailed, setIconLoadFailed] = React.useState<boolean>(false);
  const [isTechnicalInfoDialogOpen, setIsTechnicalInfoDialogOpen] = React.useState<boolean>(false);

  const technicalInfoEntries = React.useMemo(
    () => [
      {
        key: 'technicalVersion',
        value: `${appVersionInfo.version || '0.0.0'} (build ${appVersionInfo.buildVersion || '0'})`,
      },
      { key: 'technicalCommit', value: appVersionInfo.commit },
      { key: 'technicalDate', value: formatBuildTime(appVersionInfo.buildTime) },
      { key: 'technicalElectron', value: appVersionInfo.electron },
      { key: 'technicalChromium', value: appVersionInfo.chromium },
      { key: 'technicalNode', value: appVersionInfo.node },
      { key: 'technicalV8', value: appVersionInfo.v8 },
      { key: 'technicalOs', value: appVersionInfo.os },
    ],
    [appVersionInfo],
  );

  const technicalInfoText = React.useMemo(() => {
    return technicalInfoEntries
      .map((entry) => {
        const label = t(`settings.about.${entry.key}`);
        const value = formatTechnicalValue(entry.value);
        return `${label}: ${value}`;
      })
      .join('\n');
  }, [technicalInfoEntries]);

  const handleCopyTechnicalInfo = React.useCallback(() => {
    void navigator.clipboard.writeText(technicalInfoText).catch(() => {
      onOpenFailed('settings.about.copyTechnicalInfoFailed');
    });
  }, [onOpenFailed, technicalInfoText]);

  return (
    <div className="grid gap-4 pb-4">
      <section className="mx-auto grid w-full max-w-[600px] gap-3">
        <div className="flex flex-col items-center gap-3 px-2 py-1">
          <div className="bg-elevated flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border border-home-divider">
            {!iconLoadFailed ? (
              <img
                src={APP_LOGO_URL}
                alt={t('settings.about.appIconAlt')}
                className="h-full w-full object-cover"
                onDragStart={(event) => {
                  event.preventDefault();
                }}
                onError={() => setIconLoadFailed(true)}
              />
            ) : (
              <Info className="h-10 w-10 text-home-text-subtle" />
            )}
          </div>
          <h2 className="text-home-text text-2xl font-semibold">{appVersionInfo.appName}</h2>
          <div className="grid justify-items-center gap-1">
            <p className="select-text text-sm text-home-text-subtle">
              {t('settings.about.versionDisplay', {
                version: appVersionInfo.version,
                build: appVersionInfo.buildVersion || '0',
              })}
            </p>
          </div>
        </div>

        <div className="grid gap-2 px-2.5 pt-5">
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-home-text-subtle">{t('settings.about.openSourceLicense')}</span>
            <span className="text-home-text select-text">GPL-3.0-only</span>
          </div>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-home-text-subtle">{t('settings.about.github')}</span>
            <button
              type="button"
              className="text-home-text select-text underline hover:text-home-text-subtle"
              onClick={() => {
                void window.electron?.openExternalUrl?.('https://github.com/agoudbg/cosmosh').then((opened) => {
                  if (!opened) {
                    onOpenFailed('settings.about.openGithubFailed');
                  }
                });
              }}
            >
              https://github.com/agoudbg/cosmosh
            </button>
          </div>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-home-text-subtle">{t('settings.about.website')}</span>
            <button
              type="button"
              className="text-home-text select-text underline hover:text-home-text-subtle"
              onClick={() => {
                void window.electron?.openExternalUrl?.('https://cosmosh.pages.dev').then((opened) => {
                  if (!opened) {
                    onOpenFailed('settings.about.openWebsiteFailed');
                  }
                });
              }}
            >
              https://cosmosh.pages.dev
            </button>
          </div>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-home-text-subtle">{t('settings.about.buildTimeLabel')}</span>
            <span className="text-home-text select-text">{formatBuildTime(appVersionInfo.buildTime)}</span>
          </div>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-home-text-subtle">{t('settings.about.technicalInfo')}</span>
            <button
              type="button"
              className="text-home-text select-text underline hover:text-home-text-subtle"
              onClick={() => {
                setIsTechnicalInfoDialogOpen(true);
              }}
            >
              {t('settings.about.technicalInfoAction')}
            </button>
          </div>
        </div>

        <p className="px-2.5 text-xs text-home-text-subtle">{t('settings.about.copyright')}</p>
      </section>

      <Dialog
        open={isTechnicalInfoDialogOpen}
        onOpenChange={setIsTechnicalInfoDialogOpen}
      >
        <DialogContent className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle>{t('settings.about.technicalInfo')}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-2 rounded-md border border-home-divider p-3 text-sm">
            {technicalInfoEntries.map((entry) => (
              <div
                key={entry.key}
                className="grid grid-cols-[auto,1fr] items-start gap-3"
              >
                <span className="text-home-text-subtle">{t(`settings.about.${entry.key}`)}</span>
                <span className="text-home-text select-text break-all text-right">
                  {formatTechnicalValue(entry.value)}
                </span>
              </div>
            ))}
          </div>

          <DialogFooter>
            <DialogSecondaryButton onClick={handleCopyTechnicalInfo}>{t('settings.about.copy')}</DialogSecondaryButton>
            <DialogPrimaryButton onClick={() => setIsTechnicalInfoDialogOpen(false)}>
              {t('settings.about.confirm')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SettingsAboutSection;
