// Lets Critique's pages know they're running inside the desktop app, so the dashboard leaves
// notifications to the app (native macOS notifications) instead of showing browser ones too.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('critiqueDesktop', { isDesktop: true });
