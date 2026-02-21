import DefaultTheme from 'vitepress/theme';
import { inBrowser } from 'vitepress';
import type { Theme } from 'vitepress';
import mermaid from 'mermaid';
import { nextTick } from 'vue';

const theme: Theme = {
  ...DefaultTheme,
  enhanceApp({ router }) {
    if (!inBrowser) {
      return;
    }

    const renderMermaid = async (): Promise<void> => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        flowchart: {
          htmlLabels: false,
        },
      });
      await mermaid.run({ querySelector: '.mermaid' });
    };

    const scheduleRender = (): void => {
      void nextTick(() => {
        setTimeout(() => {
          void renderMermaid();
        }, 0);
      });
    };

    scheduleRender();

    router.onAfterRouteChanged = () => {
      scheduleRender();
    };
  },
};

export default theme;
