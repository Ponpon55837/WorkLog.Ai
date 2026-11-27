import { relative } from "node:path";
import process from "node:process";
import { afterAll, afterEach, expect } from "vitest";
import {
  finishSqliteTiming,
  isSqliteTimingInstalled,
  recordTestDuration,
  setSqliteTimingTestNameProvider,
} from "./sqlite-timing.js";

if (process.env.WI_SQLITE_TIMING === "1" && isSqliteTimingInstalled()) {
  setSqliteTimingTestNameProvider(
    () => expect.getState().currentTestName,
    () => {
      const testPath = expect.getState().testPath;
      return testPath === undefined ? undefined : relative(process.cwd(), testPath).replaceAll("\\", "/");
    },
  );
  afterEach((context) => {
    const startedAt = context.task.result?.startTime;
    if (startedAt !== undefined) recordTestDuration(context.task.name, Date.now() - startedAt);
  });
  afterAll(() => {
    // Written straight to fd 1: vitest's console interception can swallow console.log from setup files.
    finishSqliteTiming(true);
  });
}
