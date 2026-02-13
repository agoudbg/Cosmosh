export type TabPage = 'home' | 'ssh' | 'settings' | 'components-field';

export type TabIconKey = 'home' | 'ssh' | 'settings' | 'file' | 'terminal';

export type TabItem = {
  id: string;
  title: string;
  page: TabPage;
  iconKey: TabIconKey;
  closable?: boolean;
};
