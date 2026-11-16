import { runDesktopChild } from "../../apps/server/src/desktop-child.js";

// Child-process entry for the desktop child tests: what `work-intelligence start --desktop-ipc` runs, without the CLI.
process.exitCode = await runDesktopChild();
