import assert from 'node:assert/strict';
import test from 'node:test';

import type { TabItem, TerminalTabPresentation } from '../types/tabs';
import { projectTabPresentation, resolveTerminalTabTitle } from './tab-presentation';

const BASE_TAB: TabItem = {
  id: 'tab-1',
  title: 'Legacy fallback',
  page: 'ssh',
  iconKey: 'ssh',
  terminalTitleSources: {
    defaultTitle: 'SSH',
    connectionTitle: 'production.example.com',
    manualTitle: null,
  },
};

const APPLICATION_PRESENTATION: TerminalTabPresentation = {
  applicationTitle: 'Claude Code task',
  progressState: 'normal',
  progressValue: 40,
  progressSource: 'active-pane',
  bellAttention: false,
  bellAttentionPaneIds: [],
  latestBellEvent: null,
};

test('terminal title priority keeps manual, application, connection, and default sources independent', () => {
  assert.equal(
    resolveTerminalTabTitle(
      {
        ...BASE_TAB,
        terminalTitleSources: {
          ...BASE_TAB.terminalTitleSources!,
          manualTitle: 'Pinned title',
        },
      },
      APPLICATION_PRESENTATION,
    ),
    'Pinned title',
  );
  assert.equal(resolveTerminalTabTitle(BASE_TAB, APPLICATION_PRESENTATION), 'Claude Code task');
  assert.equal(
    resolveTerminalTabTitle(BASE_TAB, {
      ...APPLICATION_PRESENTATION,
      applicationTitle: null,
    }),
    'production.example.com',
  );
  assert.equal(
    resolveTerminalTabTitle(
      {
        ...BASE_TAB,
        terminalTitleSources: {
          ...BASE_TAB.terminalTitleSources!,
          connectionTitle: null,
        },
      },
      {
        ...APPLICATION_PRESENTATION,
        applicationTitle: null,
      },
    ),
    'SSH',
  );
});

test('terminal projection is ephemeral and leaves the stored tab unchanged', () => {
  const projected = projectTabPresentation(BASE_TAB, APPLICATION_PRESENTATION);

  assert.notEqual(projected, BASE_TAB);
  assert.equal(projected.title, 'Claude Code task');
  assert.equal(projected.terminalPresentation, APPLICATION_PRESENTATION);
  assert.equal(BASE_TAB.title, 'Legacy fallback');
  assert.equal(BASE_TAB.terminalPresentation, undefined);
});

test('non-terminal tabs remain unchanged by terminal presentation projection', () => {
  const homeTab: TabItem = {
    id: 'home',
    title: 'Home',
    page: 'home',
    iconKey: 'home',
  };

  assert.equal(projectTabPresentation(homeTab, APPLICATION_PRESENTATION), homeTab);
});
