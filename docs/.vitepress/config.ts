import { defineConfig } from "vitepress";

// GitHub Pages serves the project site under /design-iq/; the docs
// workflow (.github/workflows/docs.yml) sets DOCS_BASE accordingly.
// Local dev and preview keep the default "/".
const base = process.env.DOCS_BASE ?? "/";

// GitHub's heading ids (github-slugger: lowercase, punctuation dropped, each
// space a "-"), so a `#anchor` in these pages lands on the same heading on
// GitHub and on the site. VitePress' own slugify differs ("Reverse proxy &
// TLS" is `reverse-proxy--tls` on GitHub, `reverse-proxy-tls` here).
const githubSlug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");

export default defineConfig({
  base,
  lang: "en-US",
  // The product name (corporate design: a tool is "Miragon" plus its name);
  // the packages keep their @miragon/design-iq-* and @designiq/* names.
  title: "Miragon designIQ",
  description:
    "A self-hostable modeling workspace on your GitHub repo, where your team and AI assistants edit the same live models and every release is a pull request.",
  cleanUrls: true,
  lastUpdated: true,

  // The docs that stay in docs/ for GitHub readers and maintainers but are not
  // site pages: working notes from the platform's design (concept, multi-repo
  // gap analysis) and the widget chrome spec the sources cite as `spec §n`.
  srcExclude: ["platform-concept.md", "multi-repo-architecture.md", "mcp-app-widget-chrome.md"],

  // A folder's README.md is its index page on GitHub; here it becomes the
  // section's index (/on-prem/, /adr/). Links to it are written as `./` or
  // `../on-prem/`, which resolve on both.
  rewrites: {
    "on-prem/README.md": "on-prem/index.md",
    "adr/README.md": "adr/index.md",
  },

  // Code blocks sit on --cd-grau (light) and a white lift of --cd-schwarz
  // (dark). There, github-light-high-contrast and github-dark-default keep
  // every token colour at WCAG AA (the lowest, comments, at 4.72:1 and
  // 4.98:1); VitePress' default pair github-light/github-dark and
  // github-light-default (comments 4.26:1 on --cd-grau) don't.
  markdown: {
    theme: { light: "github-light-high-contrast", dark: "github-dark-default" },
    anchor: { slugify: githubSlug },
  },

  head: [
    // The app icon of Miragon software: the green Komet on the blue tile,
    // the CI's file unchanged. Head links are not rewritten for `base`.
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}logo/miragon-komet-blau.svg` }],
    // CI primary blue (--cd-blau) for the browser chrome
    ["meta", { name: "theme-color", content: "#335DE5" }],
  ],

  // Preload the self-hosted Geist (hashed file name, so a static head link
  // can't point at it; see vitepress.dev site-config#transformhead).
  transformHead({ assets }) {
    const geist = assets.find((file) => /geist-latin-wght-normal\.[\w-]+\.woff2$/.test(file));
    if (!geist) return;
    return [["link", { rel: "preload", href: geist, as: "font", type: "font/woff2", crossorigin: "" }]];
  },

  themeConfig: {
    // The official wordmarks: green (the standard) on light, white on dark.
    logo: {
      light: "/logo/miragon-logo-gruen.svg",
      dark: "/logo/miragon-logo-weiss.svg",
      alt: "Miragon",
    },
    // A product shows the wordmark and writes its name next to it in Geist;
    // the wordmark already reads MIRAGON, so the nav reads "MIRAGON designIQ"
    // (and its link's accessible name "Miragon designIQ").
    siteTitle: "designIQ",
    nav: [
      { text: "Getting started", link: "/getting-started", activeMatch: "^/getting-started" },
      { text: "Self-hosting", link: "/on-prem/", activeMatch: "^/(on-prem/|upgrading-to-5)" },
      { text: "AI clients", link: "/mcp-integration", activeMatch: "^/mcp-integration" },
      { text: "Extending", link: "/extending/connectors", activeMatch: "^/extending/" },
      { text: "Architecture", link: "/adr/", activeMatch: "^/adr/" },
      { text: "miragon.ai", link: "https://miragon.ai/tools/design-iq/" },
    ],

    // One sidebar for the whole site; the decision records sit collapsed at
    // the end and open on their own pages.
    sidebar: [
      {
        text: "Getting started",
        items: [{ text: "Getting started", link: "/getting-started" }],
      },
      {
        text: "Self-hosting",
        items: [
          { text: "Overview", link: "/on-prem/" },
          { text: "IdP quickstart", link: "/on-prem/idp-quickstart" },
          { text: "GitHub App setup", link: "/on-prem/github-app-setup" },
          { text: "Configuration", link: "/on-prem/configuration" },
          { text: "Upgrading to 5.0", link: "/upgrading-to-5" },
        ],
      },
      {
        text: "AI clients",
        items: [{ text: "MCP integration", link: "/mcp-integration" }],
      },
      {
        text: "Extending",
        items: [
          { text: "Connectors", link: "/extending/connectors" },
          { text: "SSO", link: "/extending/sso" },
          { text: "IdP setup for MCP clients", link: "/extending/mcp-idp-setup" },
        ],
      },
      {
        text: "Architecture",
        collapsed: true,
        items: [
          { text: "Decision records", link: "/adr/" },
          { text: "0001 Zero stored user tokens", link: "/adr/0001-zero-stored-user-tokens" },
          { text: "0002 Multi-tenant cells", link: "/adr/0002-multi-tenant-cell-architecture" },
          { text: "0003 Module architecture", link: "/adr/0003-module-architecture-and-shared-packages" },
          { text: "0004 Open-source split", link: "/adr/0004-open-source-split" },
          { text: "0005 In-process MCP, OIDC", link: "/adr/0005-in-process-mcp-and-oidc-resource-server" },
          { text: "0006 Notation plugins", link: "/adr/0006-notation-plugins-and-structured-doc-shape" },
          { text: "0007 IdP-only login", link: "/adr/0007-idp-only-login-and-no-auth-mode" },
          { text: "0008 Rename to designIQ", link: "/adr/0008-rename-to-designiq" },
          { text: "0009 BPMN editing via bpmn-cli", link: "/adr/0009-bpmn-editing-through-bpmn-cli" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/Miragon/design-iq" }],

    outline: { level: [2, 3] },

    search: { provider: "local" },

    editLink: {
      pattern: "https://github.com/Miragon/design-iq/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    // A plain date in the site's language ("Oct 11, 2026"), not the reader's
    // short date and time ("10/11/26, 10:44 AM").
    lastUpdated: {
      text: "Last updated",
      formatOptions: { dateStyle: "medium", forceLocale: true },
    },

    // Say what happened and what to do, in sentence case (VitePress' default
    // is an all-caps "PAGE NOT FOUND" and a quote).
    notFound: {
      title: "This page doesn't exist",
      quote: "The link may be outdated. Search the docs, or start at the docs home.",
      linkLabel: "Go to the docs home",
      linkText: "Go to the docs home",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © Miragon",
    },
  },
});
