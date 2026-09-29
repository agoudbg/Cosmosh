import '../../../index.css';

import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ViteHotContext } from 'vite/types/hot.d.ts';

import { setLocale } from '../../../lib/i18n';
import type { EnhancementStatusInput } from '../remote-enhancement-status';
import { RemoteEnhancementsStatus } from '../RemoteEnhancementsStatus';
import { createEnhancementStatusFixture } from './enhancement-status-fixture-data';

declare global {
  interface Window {
    enhancementStatusFixture: {
      read: () => EnhancementStatusInput;
      reset: () => void;
      update: (input: Partial<EnhancementStatusInput>) => void;
      pane: (index: number) => void;
      tab: (active: boolean) => void;
      locale: (locale: string) => Promise<void>;
    };
  }
}

/** @returns The production dialog with only incoming pane observations replaced by fixture state. */
export const EnhancementStatusFixture = (): React.ReactNode => {
  const [input, setInput] = React.useState(createEnhancementStatusFixture);
  const [paneNumber, setPaneNumber] = React.useState(1);
  const [active, setActive] = React.useState(true);
  const [, refreshLocale] = React.useReducer((value: number) => value + 1, 0);
  window.enhancementStatusFixture = {
    read: () => input,
    reset: () => setInput(createEnhancementStatusFixture()),
    update: (change) => setInput((previous) => ({ ...previous, ...change })),
    pane: setPaneNumber,
    tab: setActive,
    locale: async (locale) => {
      await setLocale(locale);
      refreshLocale();
    },
  };
  return (
    <main className="h-screen bg-bg p-4 text-text">
      <div className="w-full max-w-xs">
        {active ? (
          <RemoteEnhancementsStatus
            key={paneNumber}
            input={input}
            paneNumber={paneNumber}
          />
        ) : null}
      </div>
    </main>
  );
};

const fixtureRoot = createRoot(document.getElementById('root')!);
fixtureRoot.render(<EnhancementStatusFixture />);
const fixtureHot = (import.meta as ImportMeta & { hot?: ViteHotContext }).hot;
fixtureHot?.dispose(() => fixtureRoot.unmount());
