import * as Separator from '@radix-ui/react-separator';
import * as Toggle from '@radix-ui/react-toggle';
import * as Tooltip from '@radix-ui/react-tooltip';
import React from 'react';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-bg text-text">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-14 px-8 py-16">
        <header className="flex flex-col gap-6 text-left">
          <div className="inline-flex w-fit items-center gap-3 rounded-full border border-border px-4 py-2 text-sm text-text-muted">
            <span className="text-base">🛸</span>
            <span className="font-semibold uppercase tracking-[0.3em] text-text-faint">Cosmosh</span>
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">High-performance SSH workbench for operators who live in terminals.</h1>
            <p className="max-w-2xl text-base text-text-muted sm:text-lg">Dense, precise, and calm. Cosmosh keeps hundreds of sessions visible without drowning you in chrome.</p>
          </div>
        </header>

        <main className="grid gap-6 sm:grid-cols-2">
          <section className="rounded-lg border border-border bg-bg-panel p-6 shadow-soft">
            <h2 className="text-lg font-semibold">Session Control</h2>
            <p className="mt-3 text-sm text-text-muted">Pin critical hosts, batch reconnect, and keep the run book within a single keystroke.</p>
            <DemoControls />
          </section>
          <section className="rounded-lg border border-border bg-bg-panel p-6 shadow-soft">
            <h2 className="text-lg font-semibold">Telemetry Focus</h2>
            <p className="mt-3 text-sm text-text-muted">Live latency and throughput cues stay visible without pulling focus from your commands.</p>
          </section>
          <section className="rounded-lg border border-border bg-bg-panel p-6 shadow-soft">
            <h2 className="text-lg font-semibold">Theme-ready</h2>
            <p className="mt-3 text-sm text-text-muted">Tokenized colors and radiuses are mapped to CSS variables for instant customization.</p>
          </section>
          <section className="rounded-lg border border-border bg-bg-panel p-6 shadow-soft">
            <h2 className="text-lg font-semibold">Command Memory</h2>
            <p className="mt-3 text-sm text-text-muted">Structured history and snippets stay close, even across dozens of concurrent sessions.</p>
          </section>
        </main>

        <footer className="flex flex-wrap items-center gap-4 border-t border-border pt-6 text-sm text-text-faint">
          <span>Renderer preview</span>
          <span className="h-1 w-1 rounded-full bg-text-faint" />
          <span>Dark theme active</span>
        </footer>
      </div>
    </div>
  );
};

const DemoControls: React.FC = () => {
  const [isPinned, setIsPinned] = React.useState(false);

  return (
    <Tooltip.Provider delayDuration={120} skipDelayDuration={0}>
      <div className="bg-bg-subtle/40 mt-6 rounded-lg border border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Radix + Tailwind example</p>
            <p className="text-xs text-text-muted">Using unstyled primitives with custom tokens.</p>
          </div>
          <Separator.Root orientation="vertical" className="mx-3 h-8 w-px bg-border" />
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <Toggle.Root
                pressed={isPinned}
                className="radix-state-on:bg-accent/15 hover:border-accent/60 inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-text transition hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent radix-state-on:border-accent radix-state-on:text-accent"
                onPressedChange={setIsPinned}
              >
                <span className="h-2 w-2 rounded-full bg-text-muted radix-state-on:bg-accent" />
                {isPinned ? 'Pinned' : 'Pin session'}
              </Toggle.Root>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="bottom"
                align="end"
                sideOffset={8}
                className="animate-content-show rounded-md border border-border bg-bg-panel px-3 py-2 text-xs text-text shadow-soft radix-side-top:origin-bottom radix-side-bottom:origin-top"
              >
                Toggle comes unstyled; Tailwind handles the look.
                <Tooltip.Arrow className="fill-border" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </div>
      </div>
    </Tooltip.Provider>
  );
};

export default App;
