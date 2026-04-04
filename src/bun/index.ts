// Set desktop mode before importing server (skips auth)
process.env.OCD_MODE = "desktop";

import { BrowserWindow, ApplicationMenu } from "electrobun/bun";

// Start the HTTP server (same one used by the web version)
await import("../server/index.ts");

ApplicationMenu.setApplicationMenu([
  {
    label: "Edit",
    submenu: [
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);

const mainWindow = new BrowserWindow({
  title: "One-Click Deploy",
  url: "views://mainview/index.html",
  frame: {
    width: 500,
    height: 500,
    x: 200,
    y: 100,
  },
});
