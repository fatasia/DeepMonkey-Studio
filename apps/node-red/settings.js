const path = require("node:path");

const adminUser = process.env.NODE_RED_ADMIN_USER;
const adminPasswordHash = process.env.NODE_RED_ADMIN_PASSWORD_HASH;

module.exports = {
  flowFile: path.join(__dirname, "flows.json"),
  flowFilePretty: true,
  httpAdminRoot: "/node-red",
  httpNodeRoot: "/iot",
  uiPort: Number(process.env.NODE_RED_PORT || 1880),
  uiHost: process.env.NODE_RED_HOST || "127.0.0.1",
  credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || "bim-studio-local-change-me",
  ...(adminUser && adminPasswordHash ? { adminAuth: {
    type: "credentials",
    users: [{ username: adminUser, password: adminPasswordHash, permissions: "*" }]
  } } : {}),
  editorTheme: {
    theme: "dark-modern",
    page: { title: "BIM Studio · 流程与看板", favicon: false },
    header: { title: "BIM Studio · 数字孪生流程", image: null },
    projects: { enabled: false },
    tours: false,
    customCss: path.join(__dirname, "theme", "bim-studio.css")
  },
  telemetry: { enabled: false, updateNotification: false },
  functionGlobalContext: {},
  logging: { console: { level: "info", metrics: false, audit: false } },
  exportGlobalContextKeys: false,
  externalModules: { autoInstall: false }
};
