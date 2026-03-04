import { defineConfig } from 'vitepress';
import type Token from 'markdown-it/lib/token.mjs';

export default defineConfig({
  title: 'Cosmosh Docs',
  description: 'Architecture, governance, and engineering documentation for Cosmosh.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  appearance: true,
  markdown: {
    config: (md) => {
      const defaultFence = md.renderer.rules.fence;

      md.renderer.rules.fence = (tokens: Token[], idx, options, env, self): string => {
        const token = tokens[idx];
        const info = token.info.trim();

        if (info === 'mermaid') {
          const escaped = md.utils.escapeHtml(token.content);
          return `<pre class="mermaid">${escaped}</pre>`;
        }

        if (defaultFence) {
          return defaultFence(tokens, idx, options, env, self);
        }

        return self.renderToken(tokens, idx, options);
      };
    },
  },
  themeConfig: {
    siteTitle: 'Cosmosh',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'User Docs', link: '/user/getting-started' },
      { text: 'Developer Docs', link: '/developer/' },
      { text: 'GitHub', link: 'https://github.com/agoudbg/cosmosh' },
    ],
    sidebar: {
      '/user/': [
        {
          text: 'User Guides',
          items: [
            { text: 'Getting Started', link: '/user/getting-started' },
            { text: 'Install & Setup', link: '/user/install-and-setup' },
            { text: 'Manage Servers', link: '/user/manage-servers' },
            { text: 'SSH Session Basics', link: '/user/ssh-session-basics' },
            { text: 'Local Terminal Usage', link: '/user/local-terminal' },
            { text: 'Troubleshooting', link: '/user/troubleshooting' },
            { text: 'FAQ', link: '/user/faq' },
          ],
        },
      ],
      '/developer/': [
        {
          text: 'Start',
          items: [
            { text: 'Developer Docs Overview', link: '/developer/' },
          ],
        },
        {
          text: 'Developer Core',
          items: [
            { text: 'Project Map', link: '/developer/core/project-map' },
            { text: 'Architecture', link: '/developer/core/architecture' },
            { text: 'IPC Protocol', link: '/developer/core/ipc-protocol' },
          ],
        },
        {
          text: 'Developer Runtime Features',
          items: [
            { text: 'SSH Terminal', link: '/developer/runtime/ssh-terminal' },
            { text: 'Database Security', link: '/developer/runtime/database-security' },
            { text: 'SFTP File System', link: '/developer/runtime/sftp-file-system' },
          ],
        },
        {
          text: 'Developer Design & Governance',
          items: [
            { text: 'UI/UX Standards', link: '/developer/design/ui-ux-standards' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/agoudbg/cosmosh' }],
    search: {
      provider: 'local',
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/' },
          { text: 'User Docs', link: '/user/getting-started' },
          { text: 'Developer Docs', link: '/developer/' },
          { text: 'GitHub', link: 'https://github.com/agoudbg/cosmosh' },
        ],
      },
    },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh-CN/',
      themeConfig: {
        nav: [
          { text: '首页', link: '/zh-CN/' },
          { text: '用户文档', link: '/zh-CN/user/getting-started' },
          { text: '开发文档', link: '/zh-CN/developer/' },
          { text: 'GitHub', link: 'https://github.com/agoudbg/cosmosh' },
        ],
        sidebar: {
          '/zh-CN/user/': [
            {
              text: '用户指南',
              items: [
                { text: '快速上手', link: '/zh-CN/user/getting-started' },
                { text: '安装与初始化', link: '/zh-CN/user/install-and-setup' },
                { text: '服务器管理', link: '/zh-CN/user/manage-servers' },
                { text: 'SSH 会话基础', link: '/zh-CN/user/ssh-session-basics' },
                { text: '本地终端使用', link: '/zh-CN/user/local-terminal' },
                { text: '故障排查', link: '/zh-CN/user/troubleshooting' },
                { text: '常见问题', link: '/zh-CN/user/faq' },
              ],
            },
          ],
          '/zh-CN/developer/': [
            {
              text: '起步',
              items: [
                { text: '开发文档总览', link: '/zh-CN/developer/' },
              ],
            },
            {
              text: '开发核心',
              items: [
                { text: '项目地图', link: '/zh-CN/developer/core/project-map' },
                { text: '架构设计', link: '/zh-CN/developer/core/architecture' },
                { text: 'IPC 协议字典', link: '/zh-CN/developer/core/ipc-protocol' },
              ],
            },
            {
              text: '开发运行时能力',
              items: [
                { text: 'SSH 终端实现', link: '/zh-CN/developer/runtime/ssh-terminal' },
                { text: '数据库安全', link: '/zh-CN/developer/runtime/database-security' },
                { text: 'SFTP 文件系统', link: '/zh-CN/developer/runtime/sftp-file-system' },
              ],
            },
            {
              text: '开发设计与治理',
              items: [
                { text: 'UI/UX 规范', link: '/zh-CN/developer/design/ui-ux-standards' },
              ],
            },
          ],
        },
      },
    },
  },
});
