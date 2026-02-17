export type TabPage = 'home' | 'ssh' | 'settings' | 'components-field' | 'debug';

export type TabIconKey = 'home' | 'ssh' | 'settings' | 'file' | 'terminal' | 'debug';

export type TabItem = {
  id: string;
  title: string;
  page: TabPage;
  iconKey: TabIconKey;
  closable?: boolean;
};
