import { runDesktopChild } from "../../apps/server/src/desktop-child.js";

process.exitCode = await runDesktopChild();
