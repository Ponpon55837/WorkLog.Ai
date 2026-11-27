import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpLeaseRegistration } from "@work-intelligence/shared/mcp-runtime";
import {
  AGENT_OBSERVATIONS_FILE,
  mcpContractFingerprint,
  SELFTEST_CLIENT_NAME,
} from "@work-intelligence/shared/mcp-contract-fingerprint";

export interface AgentObservation {
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  contractFingerprint: string;
  serverVersion: string;
  observedAt: string;
  /** This process's lease scope id and whether its lease directory worked (no path); absent in files written by 1.6.59 and earlier. */
  lease?: McpLeaseRegistration;
}

export interface AgentObservationFile {
  version: 1;
  observations: Record<string, AgentObservation>;
}

export interface AgentObservationRecorderOptions {
  directory: string;
  serverVersion: string;
  now?: () => Date;
  lease?: () => McpLeaseRegistration;
  /** Failures are reported here (stderr) and never thrown: observing a host must not affect its MCP session. */
  onError?: (error: unknown) => void;
}

/** @internal test-only */
export { AGENT_OBSERVATIONS_FILE };

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

function mergedContent(observations: Map<string, AgentObservation>, observation: AgentObservation): string {
  observations.delete(observation.clientName);
  observations.set(observation.clientName, observation);
  const content: AgentObservationFile = {
    version: 1,
    observations: Object.fromEntries([...observations].slice(-MAX_CLIENTS)),
  };
  return `${JSON.stringify(content, null, 2)}\n`;
}

/** @internal test-only */
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
 * Each write re-reads the file right before its rename so another process's entry is kept; two writers interleaving
 * within milliseconds can still lose one entry, which the next session of that host records again.
 */
export class AgentObservationRecorder {
  private readonly options: AgentObservationRecorderOptions;
  private protocolVersion: string | undefined;
  private recorded = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  public constructor(options: AgentObservationRecorderOptions) {
    this.options = options;
  }

  public attach(server: McpServer, transport: Transport): void {
    const send = transport.send.bind(transport);
    transport.send = async (message, sendOptions) => {
      await send(message, sendOptions);
      if (this.recorded) return;
      try {
        this.inspect(server, message);
      } catch (error) {
        // Observing must never throw into the SDK transport: the host's response was already sent.
        this.options.onError?.(error);
      }
    };
  }

  public async settled(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.pendingWrite;
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
      ...(this.options.lease ? { lease: this.options.lease() } : {}),
    };
    this.pendingWrite = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.write(observation)
          .catch((error: unknown) => this.options.onError?.(error))
          .finally(resolve);
      });
    });
  }

  private async write(observation: AgentObservation): Promise<void> {
    const { directory } = this.options;
    const target = join(directory, AGENT_OBSERVATIONS_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      const first = mergedContent(await readAgentObservations(directory), observation);
      await writeFile(temporary, first, { mode: 0o600 });
      // Read again right before the rename, so an entry another process added while this one was writing is kept.
      const latest = mergedContent(await readAgentObservations(directory), observation);
      if (latest !== first) await writeFile(temporary, latest, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
