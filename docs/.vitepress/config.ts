// The docs site, built with the Miragon docs kit (docs/.vitepress/miragon/, vendored from
// Miragon/corporate-identity, skill docs-site). The kit sets everything else: base from
// DOCS_BASE, theme, colours light and dark, GitHub anchors, Mermaid, search, the legal row.
import { miragonDocs } from "./miragon/config";

export default miragonDocs({
  repo: "Miragon/design-iq",
  // The product name (corporate design: a tool is "Miragon" plus its name); the packages
  // keep their @miragon/design-iq-* and @designiq/* names.
  title: "Miragon designIQ",
  siteTitle: "designIQ",
  description:
    "A self-hostable modeling workspace on your GitHub repo, where your team and AI assistants edit the same live models and every release is a pull request.",
  productPage: "https://miragon.ai/tools/design-iq/",
  footerMessage: "Released under the MIT License.",

  // The docs that stay in docs/ for GitHub readers and maintainers but are not site pages:
  // working notes from the platform's design (concept, multi-repo gap analysis) and the
  // widget chrome spec the sources cite as `spec §n`.
  srcExclude: ["platform-concept.md", "multi-repo-architecture.md", "mcp-app-widget-chrome.md"],

  // A folder's README.md is its index page on GitHub; here it becomes the section's index
  // (/on-prem/, /adr/). Links to it are written as `./` or `../on-prem/`, which resolve on both.
  rewrites: {
    "on-prem/README.md": "on-prem/index.md",
    "adr/README.md": "adr/index.md",
  },

  nav: [
    { text: "Getting started", link: "/getting-started", activeMatch: "^/getting-started" },
    { text: "Self-hosting", link: "/on-prem/", activeMatch: "^/(on-prem/|upgrading-to-5)" },
    { text: "AI clients", link: "/mcp-integration", activeMatch: "^/mcp-integration" },
    { text: "Extending", link: "/extending/connectors", activeMatch: "^/extending/" },
    { text: "Architecture", link: "/adr/", activeMatch: "^/adr/" },
  ],

  // One sidebar for the whole site; the decision records sit collapsed at the end and open
  // on their own pages.
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
});
