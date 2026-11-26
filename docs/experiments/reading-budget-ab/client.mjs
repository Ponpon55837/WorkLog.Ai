// The Agent's only connection to Work Intelligence during an A/B run.
//
//   node client.mjs <run directory> instructions
//   node client.mjs <run directory> tools
//   node client.mjs <run directory> resources
//   node client.mjs <run directory> read <uri>
//   node client.mjs <run directory> call <tool> <arguments JSON | @file.json>
//
// Each command prints the server's answer as JSON.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function send(runDir, request) {
  return new Promise((done, fail) => {
    let buffer = "";
    const socket = connect(join(runDir, "broker.sock"), () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => (buffer += chunk));
    socket.on("end", () => done(JSON.parse(buffer)));
    socket.on("error", fail);
  });
}

function parseArguments(value) {
  if (value === undefined) return {};
  return JSON.parse(value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value);
}

async function main() {
  const [runDir, command, first, second] = process.argv.slice(2);
  if (!runDir || !command) {
    console.error("Usage: node client.mjs <run directory> instructions|tools|resources|read <uri>|call <tool> <json>");
    process.exit(2);
  }
  const request =
    command === "read"
      ? { cmd: "read", uri: first }
      : command === "call"
        ? { cmd: "call", tool: first, arguments: parseArguments(second) }
        : { cmd: command };
  const response = await send(resolve(runDir), request);
  if (!response.ok) {
    console.log(JSON.stringify({ error: response.error }));
    process.exit(1);
  }
  const result = response.result;
  const text = result?.text ?? result?.contents?.[0]?.text ?? result?.content?.[0]?.text;
  console.log(typeof text === "string" && command !== "tools" ? text : JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
