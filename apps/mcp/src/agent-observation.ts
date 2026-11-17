import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mcpContractFingerprint, SELFTEST_CLIENT_NAME } from "@work-intelligence/shared/mcp-contract-fingerprint";

/** What one real Agent host showed the server; no path, project or user data. */
export interface AgentObservation {
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  /** Fingerprint of the tool list the host received, comparable with the desktop self-test's. */
  contractFingerprint: string;
  serverVersion: string;
  observedAt: string;
}

export interface AgentObservationFile {
  version: 1;
  /** Keyed by `clientInfo.name`. */
  observations: Record<string, AgentObservation>;
}

export interface AgentObservationRecorderOptions {
  /** The Work Intelligence config directory the file lives in. */
  directory: string;
  serverVersion: string;
  now?: () => Date;
  /** Failures are reported here (stderr) and never thrown: observing a host must not affect its MCP session. */
  onError?: (error: unknown) => void;
}

export const AGENT_OBSERVATIONS_FILE = "agent-observations.json";

const MAX_FIELD_LENGTH = 100;
/** A hostile or buggy host cannot grow the file past this many distinct client names; the oldest are dropped. */
const MAX_CLIENTS = 16;

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_FIELD_LENGTH) : undefined;
}

function resultOf(message: JSONRPCMessage): Record<string, unknown> | undefined {
  if (!("result" in message)) return undefined;
  const result: unknown = message.result;
  return result !== null && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
}

/** The file's observations; a missing, unreadable or malformed file counts as empty and is rewritten whole. */
export async function readAgentObservations(directory: string): Promise<Map<string, AgentObservation>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, AGENT_OBSERVATIONS_FILE), "utf8"));
    const entries = (parsed as Partial<AgentObservationFile> | null)?.observations;
    if (entries === null || typeof entries !== "object") return new Map();
    return new Map(Object.entries(entries).filter(([, value]) => value !== null && typeof value === "object"));
  } catch {
    return new Map();
  }
}

/**
 * Records, once per process and client, that a real host completed `initialize` and received `tools/list`, so the
 * desktop can show "observed connected" only for an Agent that really talked to this server. It watches the
 * responses leaving the transport (the host's exact view of the contract) and writes after the response is sent;
 * the single small atomic write runs off the request path and any failure only reaches stderr.
 */
export class AgentObservationRecorder {
  private readonly options: AgentObservationRecorderOptions;
  private protocolVersion: string | undefined;
  private recorded = false;

  public constructor(options: AgentObservationRecorderOptions) {
    this.options = options;
  }

  /** Wraps `transport.send`; call before `server.connect(transport)`. */
  public attach(server: McpServer, transport: Transport): void {
    const send = transport.send.bind(transport);
    transport.send = async (message, sendOptions) => {
      await send(message, sendOptions);
      if (!this.recorded) this.inspect(server, message);
    };
  }

  private inspect(server: McpServer, message: JSONRPCMessage): void {
    const result = resultOf(message);
    if (!result) return;
    if (typeof result.protocolVersion === "string") {
      this.protocolVersion = result.protocolVersion;
      return;
    }
    if (!Array.isArray(result.tools) || this.protocolVersion === undefined) return;
    const client = server.server.getClientVersion();
    const clientName = boundedText(client?.name);
    if (clientName === undefined || clientName === SELFTEST_CLIENT_NAME) return;
    this.recorded = true;
    const observation: AgentObservation = {
      clientName,
      clientVersion: boundedText(client?.version) ?? "",
      protocolVersion: this.protocolVersion,
      contractFingerprint: mcpContractFingerprint(result.tools),
      serverVersion: this.options.serverVersion,
      observedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    setImmediate(() => void this.write(observation).catch((error: unknown) => this.options.onError?.(error)));
  }

  private async write(observation: AgentObservation): Promise<void> {
    const { directory } = this.options;
    const observations = await readAgentObservations(directory);
    observations.delete(observation.clientName);
    observations.set(observation.clientName, observation);
    const kept = [...observations].slice(-MAX_CLIENTS);
    const content: AgentObservationFile = { version: 1, observations: Object.fromEntries(kept) };
    await mkdir(directory, { recursive: true });
    const target = join(directory, AGENT_OBSERVATIONS_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
