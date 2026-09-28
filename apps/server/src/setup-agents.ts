import { createInterface } from "node:readline/promises";
import { defaultAgentSetupDependencies, runAgentSetupCli } from "./agent-setup.js";

async function main(): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const dependencies = defaultAgentSetupDependencies(
      (message) => console.log(message),
      interactive ? async (question) => (await readline.question(question)).trim().toLowerCase() === "yes" : undefined,
    );
    if (!interactive) console.log("非互動終端僅顯示預覽；如需寫入，請在互動終端重新執行。\n");
    process.exitCode = await runAgentSetupCli(process.argv.slice(2), dependencies);
  } finally {
    readline.close();
  }
}

void main();
