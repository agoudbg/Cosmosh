import React from 'react';

import { getLocale, setLocale, t } from '../lib/i18n';
import type { TabIconKey } from '../types/tabs';

type HomeProps = {
  onOpenSSH: () => void;
  onOpenSettings: () => void;
  onRenameTab: (title: string) => void;
  onChangeIcon: (iconKey: TabIconKey) => void;
  activeTabTitle: string;
  activeTabIcon: TabIconKey;
};

const Home: React.FC<HomeProps> = ({
  onOpenSSH,
  onOpenSettings,
  onRenameTab,
  onChangeIcon,
  activeTabTitle,
  activeTabIcon,
}) => {
  const [draftTitle, setDraftTitle] = React.useState<string>(activeTabTitle);
  const [locale, setLocaleState] = React.useState<'en' | 'zh-CN'>(getLocale());

  React.useEffect(() => {
    setDraftTitle(activeTabTitle);
  }, [activeTabTitle]);

  const handleToggleLocale = React.useCallback(async () => {
    const nextLocale = locale === 'en' ? 'zh-CN' : 'en';
    const syncedLocale = await setLocale(nextLocale);
    setLocaleState(syncedLocale);
  }, [locale]);

  // Demonstration samples to validate placeholder and plural support in runtime.
  const formatSamples = React.useMemo(() => {
    return [
      t('home.formatNamed', { name: 'agou', profile: 'prod' }),
      t('home.formatPrintf', [58, 'ok']),
      t('home.formatIndexed', ['node-a', 3]),
      t('home.pluralSessions', { count: 0 }),
      t('home.pluralSessions', { count: 1 }),
      t('home.pluralSessions', { count: 3 }),
    ];
  }, [locale]);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg font-semibold">{t('home.title')}</div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="debug-button"
          onClick={onOpenSSH}
        >
          {t('home.openSshCurrentTab')}
        </button>
        <button
          type="button"
          className="debug-button"
          onClick={onOpenSettings}
        >
          {t('home.openSettingsNewTab')}
        </button>
        <button
          type="button"
          className="debug-button"
          onClick={handleToggleLocale}
        >
          {t('home.switchLanguage')}: {locale}
        </button>
      </div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">
          {t('home.currentLanguage')}: {locale}
        </div>
        <div className="text-muted flex flex-col gap-1 text-sm">
          {formatSamples.map((sample, index) => (
            <div key={`${sample}-${index}`}>{sample}</div>
          ))}
        </div>
      </div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">Tab Debug Tools</div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Name</span>
            <input
              className="debug-input"
              value={draftTitle}
              placeholder="Tab name"
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="debug-button"
            onClick={() => onRenameTab(draftTitle.trim() || 'Untitled')}
          >
            Apply Name
          </button>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Icon</span>
            <select
              className="debug-select"
              value={activeTabIcon}
              onChange={(event) => onChangeIcon(event.target.value as TabIconKey)}
            >
              <option value="home">Home</option>
              <option value="ssh">SSH</option>
              <option value="settings">Settings</option>
              <option value="file">File</option>
              <option value="terminal">Terminal</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
};

export default Home;
