// The docs site. Project values live in site.json, so this file, sections.js and the lockfile stay
// identical to the template.
import { themes as prismThemes } from 'prism-react-renderer'
import { docsDir, hasHistory, indexFirst, sections, site } from './sections.js'

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: site.title ?? 'Docs',
  future: { v4: true },
  noIndex: Boolean(site.noIndex),

  url: process.env.DOCS_URL || 'http://localhost:3000',
  baseUrl: process.env.DOCS_BASE_PATH ? `${process.env.DOCS_BASE_PATH.replace(/\/+$/, '')}/` : '/',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  onDuplicateRoutes: 'throw',
  markdown: {
    format: 'detect',
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'throw', onBrokenMarkdownImages: 'throw' },
  },
  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      // Search works even when the site asks not to be indexed.
      { hashed: true, indexBlog: false, indexPages: false, docsRouteBasePath: '/', docsDir, forceIgnoreNoIndex: Boolean(site.noIndex) },
    ],
  ],
  i18n: { defaultLocale: 'en', locales: ['en'] },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: docsDir,
          routeBasePath: '/',
          sidebarPath: './sidebars.js',
          sidebarItemsGenerator: indexFirst,
          showLastUpdateTime: hasHistory,
          // editUrl is the URL of the docs folder; each page adds its path inside it.
          ...(site.editUrl ? { editUrl: ({ docPath }) => site.editUrl.replace(/\/?$/, '/') + docPath } : {}),
        },
        blog: false,
        pages: false,
        theme: { customCss: './src/css/custom.css' },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: { respectPrefersColorScheme: true },
      navbar: {
        title: site.title ?? 'Docs',
        items: sections().map(({ id, label }) => ({ type: 'docSidebar', sidebarId: id, label, position: 'left' })),
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'diff', ...(site.prism ?? [])],
      },
    }),
}

export default config
