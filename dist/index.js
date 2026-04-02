#!/usr/bin/env node
import { startServer } from "./server.js";
import { handleNotify } from "./notify.js";
import { runSetup, runUninstall } from "./setup.js";
const command = process.argv[2];
switch (command) {
    case "setup":
        runSetup().catch((err) => {
            console.error("Setup failed:", err.message);
            process.exit(1);
        });
        break;
    case "uninstall":
        runUninstall().catch((err) => {
            console.error("Uninstall failed:", err.message);
            process.exit(1);
        });
        break;
    case "notify": {
        const typeIdx = process.argv.indexOf("--type");
        const type = typeIdx >= 0 ? process.argv[typeIdx + 1] || "general" : "general";
        handleNotify(type).catch((err) => {
            console.error("Notify failed:", err.message);
            process.exit(1);
        });
        break;
    }
    default:
        // Default: start MCP server
        startServer().catch((err) => {
            console.error("[feishu-bridge] Fatal error:", err);
            process.exit(1);
        });
        break;
}
