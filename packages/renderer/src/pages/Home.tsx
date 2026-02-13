import React from 'react';

import { t } from '../lib/i18n';
import type { TabIconKey } from '../types/tabs';

type HomeProps = {
  onOpenSSH: () => void;
  onOpenSettings: () => void;
  onOpenComponentsField: () => void;
  onRenameTab: (title: string) => void;
  onChangeIcon: (iconKey: TabIconKey) => void;
  activeTabTitle: string;
  activeTabIcon: TabIconKey;
};

const Home: React.FC<HomeProps> = ({
  onOpenSSH,
  onOpenSettings,
  onOpenComponentsField,
  onRenameTab,
  onChangeIcon,
  activeTabTitle,
  activeTabIcon,
}) => {
  const [draftTitle, setDraftTitle] = React.useState<string>(activeTabTitle);

  React.useEffect(() => {
    setDraftTitle(activeTabTitle);
  }, [activeTabTitle]);

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
          onClick={onOpenComponentsField}
        >
          {t('home.openComponentsPlaygroundNewTab')}
        </button>
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
