import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "one-click-deploy",
    identifier: "com.one-click-deploy.app",
    version: "0.1.0",
  },
  build: {
    views: {
      mainview: {
        entrypoint: "src/mainview/index.tsx",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
    },
    mac: {
      bundleCEF: false,
      icons: "icon.iconset",
    },
    linux: {
      bundleCEF: false,
      icon: "assets/icon.png",
    },
    win: {
      bundleCEF: false,
      icon: "assets/icon.ico",
    },
  },
} satisfies ElectrobunConfig;
