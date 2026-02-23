export type TabPage = string;

export type TabIconKey = string;

export type TabItem = {
  id: string;
  title: string;
  page: TabPage;
  iconKey: TabIconKey;
  closable?: boolean;
  state?: {
    settingsCategory?: string;
  };
};
