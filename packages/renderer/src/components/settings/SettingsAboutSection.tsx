import { Info } from 'lucide-react';
import React from 'react';

import { t } from '../../lib/i18n';

export type AppVersionInfo = {
  appName: string;
  version: string;
  buildVersion: string;
  buildTime: string;
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

const SettingsAboutSection: React.FC<SettingsAboutSectionProps> = ({ appVersionInfo, onOpenFailed }) => {
  const [iconLoadFailed, setIconLoadFailed] = React.useState<boolean>(false);

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
        </div>

        <p className="px-2.5 text-xs text-home-text-subtle">{t('settings.about.copyright')}</p>
      </section>
    </div>
  );
};

export default SettingsAboutSection;
