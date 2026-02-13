import { describe, expect, it } from 'vitest';

import { createI18n, createLocaleHeaders, resolveLocale } from './index';

import type { Messages } from './index';

const fixtureMessages: Messages = {
  en: {
    main: {
      demo: {
        title: 'Main Demo',
      },
    },
    renderer: {
      demo: {
        title: 'Renderer Demo',
        named: 'Hello {name}, profile: {profile}',
        printf: 'CPU %d%%, status: %s',
        indexed: 'Node %1s has %2d sessions',
        plural: '{count, plural, =0 {No sessions} one {# session} other {# sessions}}',
      },
    },
    backend: {
      demo: {
        title: 'Backend API',
      },
    },
  },
  'zh-CN': {
    main: {
      demo: {
        title: '主进程示例',
      },
    },
    renderer: {
      demo: {
        title: '渲染进程示例',
        named: '你好 {name}，配置：{profile}',
        printf: 'CPU %d%%，状态：%s',
        indexed: '节点 %1s 有 %2d 个会话',
        plural: '{count, plural, =0 {暂无会话} one {# 个会话} other {# 个会话}}',
      },
    },
    backend: {
      demo: {
        title: '后端 API',
      },
    },
  },
};

describe('i18n core', () => {
  it('resolves locale from language-like input', () => {
    expect(resolveLocale('zh-TW')).toBe('zh-CN');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale('fr-FR')).toBe('en');
  });

  it('falls back to default locale when key is missing', () => {
    const i18n = createI18n({ locale: 'zh-CN', scope: 'backend', resources: fixtureMessages });
    expect(i18n.t('demo.title')).toBe('后端 API');
    expect(i18n.t('demo.notExists')).toBe('demo.notExists');
  });

  it('switches locale at runtime', () => {
    const i18n = createI18n({ locale: 'en', scope: 'renderer', resources: fixtureMessages });
    expect(i18n.t('demo.title')).toBe('Renderer Demo');

    i18n.setLocale('zh-CN');
    expect(i18n.t('demo.title')).toBe('渲染进程示例');
  });

  it('creates locale headers for backend requests', () => {
    expect(createLocaleHeaders('zh-CN')).toEqual({ 'x-cosmosh-locale': 'zh-CN' });
  });

  it('formats named placeholders', () => {
    const i18n = createI18n({ locale: 'en', scope: 'renderer', resources: fixtureMessages });
    expect(i18n.t('demo.named', { name: 'agou', profile: 'dev' })).toBe('Hello agou, profile: dev');
  });

  it('formats printf placeholders from array params', () => {
    const i18n = createI18n({ locale: 'en', scope: 'renderer', resources: fixtureMessages });
    expect(i18n.t('demo.printf', [72, 'ok'])).toBe('CPU 72%, status: ok');
  });

  it('formats indexed placeholders', () => {
    const i18n = createI18n({ locale: 'en', scope: 'renderer', resources: fixtureMessages });
    expect(i18n.t('demo.indexed', ['node-a', 4])).toBe('Node node-a has 4 sessions');
  });

  it('formats plural forms in one translation key', () => {
    const i18n = createI18n({ locale: 'en', scope: 'renderer', resources: fixtureMessages });
    expect(i18n.t('demo.plural', { count: 0 })).toBe('No sessions');
    expect(i18n.t('demo.plural', { count: 1 })).toBe('1 session');
    expect(i18n.t('demo.plural', { count: 3 })).toBe('3 sessions');
  });
});
