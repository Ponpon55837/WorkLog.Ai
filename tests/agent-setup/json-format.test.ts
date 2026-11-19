import { describe, expect, it } from "vitest";
import { serializeJson } from "../../packages/agent-setup/src/json-config.js";

const text = (buffer: Buffer): string => buffer.toString("utf8");

describe("serializeJson keeps the file's formatting (L-22)", () => {
  const root = { a: { b: 1 } };

  it("keeps tab indentation", () => {
    expect(text(serializeJson(root, Buffer.from('{\n\t"a": {}\n}\n')))).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n');
  });

  it("keeps four-space indentation and CRLF", () => {
    expect(text(serializeJson(root, Buffer.from('{\r\n    "a": {}\r\n}\r\n')))).toBe(
      '{\r\n    "a": {\r\n        "b": 1\r\n    }\r\n}\r\n',
    );
  });

  it("does not add a trailing newline to a file that had none", () => {
    expect(text(serializeJson(root, Buffer.from('{\n  "a": {}\n}')))).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
  });

  it("writes a new or empty file with two spaces and a trailing newline", () => {
    const expected = '{\n  "a": {\n    "b": 1\n  }\n}\n';
    expect(text(serializeJson(root, null))).toBe(expected);
    expect(text(serializeJson(root, Buffer.from("")))).toBe(expected);
  });
});
