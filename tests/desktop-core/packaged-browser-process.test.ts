import { describe, expect, it } from "vitest";
import { isExternalBrowser } from "../../apps/desktop/tests/packaged-smoke/browser-process.js";

const FIREFOX = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
const DASHBOARD_PORT = 43_210;

function firefox(args: string) {
  return { executable: FIREFOX, commandLine: `"${FIREFOX}" ${args}` };
}

describe("which processes the packaged smoke counts as an external browser", () => {
  it("ignores the Firefox Default Browser Agent that the Windows Task Scheduler runs", () => {
    expect(isExternalBrowser(firefox("--backgroundtask defaultagent do-task 0123456789ABCDEF"), DASHBOARD_PORT)).toBe(
      false,
    );
  });

  it("counts Firefox opened for a URL", () => {
    expect(isExternalBrowser(firefox(`-osint -url http://127.0.0.1:${DASHBOARD_PORT}/`), DASHBOARD_PORT)).toBe(true);
    expect(isExternalBrowser(firefox("https://example.test/"), DASHBOARD_PORT)).toBe(true);
  });

  it("counts a Firefox background task whose command line names the Dashboard", () => {
    expect(
      isExternalBrowser(firefox(`--backgroundtask open http://127.0.0.1:${DASHBOARD_PORT}/`), DASHBOARD_PORT),
    ).toBe(true);
    expect(
      isExternalBrowser(firefox(`--backgroundtask open http://localhost:${DASHBOARD_PORT}/`), DASHBOARD_PORT),
    ).toBe(true);
  });

  it("matches the background-task flag only as a whole argument and only for Firefox", () => {
    expect(isExternalBrowser(firefox("--backgroundtasks defaultagent"), DASHBOARD_PORT)).toBe(true);
    expect(
      isExternalBrowser(
        { executable: undefined, commandLine: "/usr/bin/google-chrome --backgroundtask defaultagent" },
        DASHBOARD_PORT,
      ),
    ).toBe(true);
    expect(isExternalBrowser({ executable: undefined, commandLine: "/usr/bin/firefox --backgroundtask x" })).toBe(
      false,
    );
  });

  it("is not a browser when the executable is none of the browsers", () => {
    expect(isExternalBrowser({ executable: "C:\\Windows\\System32\\conhost.exe", commandLine: "conhost.exe" })).toBe(
      false,
    );
  });
});
