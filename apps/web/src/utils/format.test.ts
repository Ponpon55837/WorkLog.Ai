import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./format.js";

describe("formatBytes", () => {
  it("keeps small sizes in bytes and scales larger sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute, minute, hour, and day spans", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const end = (minutes: number): string => new Date(start + minutes * 60_000).toISOString();

    expect(formatDuration(end(0), end(0))).toBe("不到 1 分鐘");
    expect(formatDuration(end(0), end(1))).toBe("1 分鐘");
    expect(formatDuration(end(0), end(45))).toBe("45 分鐘");
    expect(formatDuration(end(0), end(63))).toBe("1 小時 3 分鐘");
    expect(formatDuration(end(0), end(1_620))).toBe("1 天 3 小時");
  });

  it("returns an empty label for invalid or reversed intervals", () => {
    expect(formatDuration("invalid", "2026-01-01T00:00:00.000Z")).toBe("");
    expect(formatDuration("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("");
  });
});
