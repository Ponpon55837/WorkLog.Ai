import type { UsageAgentId, UsageBlock, UsageEvent } from "./types.js";

const BLOCK_MS = 5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function localOffsetMinutes(time: number): number {
  return -new Date(time).getTimezoneOffset();
}

function floorToLocalHour(time: number, offsetMinutes: number): number {
  const local = time + offsetMinutes * MINUTE_MS;
  return local - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS) - offsetMinutes * MINUTE_MS;
}

interface OpenBlock {
  start: number;
  first: number;
  last: number;
  tokens: UsageBlock["tokens"];
}

function openBlock(event: UsageEvent, offsetMinutes: (time: number) => number): OpenBlock {
  return {
    start: floorToLocalHour(event.time, offsetMinutes(event.time)),
    first: event.time,
    last: event.time,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  };
}

function finishBlock(agent: UsageAgentId, block: OpenBlock, now: number): UsageBlock {
  const end = block.start + BLOCK_MS;
  const clampedNow = Math.min(Math.max(now, block.start), end);
  const minutes = (Math.max(clampedNow, block.last) - block.first) / MINUTE_MS;
  const primary = block.tokens.input + block.tokens.output;
  return {
    agent,
    start: block.start,
    end,
    firstActivity: block.first,
    lastActivity: block.last,
    tokens: block.tokens,
    primary,
    elapsedMs: clampedNow - block.start,
    remainingMs: end - now,
    primaryPerMinute: minutes < 1 ? 0 : Math.round(primary / minutes),
  };
}

export function buildActiveBlocks(
  events: readonly UsageEvent[],
  now: number,
  offsetMinutes: (time: number) => number = localOffsetMinutes,
): UsageBlock[] {
  const blocks: UsageBlock[] = [];
  for (const agent of ["claude-code", "codex"] as const) {
    const sorted = events.filter((event) => event.agent === agent).sort((a, b) => a.time - b.time);
    let current: OpenBlock | undefined;
    for (const event of sorted) {
      if (current && (event.time - current.start >= BLOCK_MS || event.time - current.last >= BLOCK_MS)) {
        current = undefined;
      }
      current ??= openBlock(event, offsetMinutes);
      current.last = event.time;
      current.tokens.input += event.tokens.input;
      current.tokens.output += event.tokens.output;
      current.tokens.cacheRead += event.tokens.cacheRead;
      current.tokens.cacheCreation += event.tokens.cacheCreation;
    }
    if (current && now < current.start + BLOCK_MS && now - current.last < BLOCK_MS) {
      blocks.push(finishBlock(agent, current, now));
    }
  }
  return blocks;
}
