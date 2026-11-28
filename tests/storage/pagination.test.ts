import { describe, expect, it } from "vitest";
import { createPageInfo } from "../../packages/storage/src/pagination.js";

describe("createPageInfo", () => {
  it("caps an All request and keeps the result navigable", () => {
    expect(createPageInfo(1, 0, 250, 100)).toMatchObject({
      page: 1,
      pageSize: 100,
      total: 250,
      totalPages: 3,
      from: 1,
      to: 100,
      hasPrevious: false,
      hasNext: true,
      truncated: true,
    });
    expect(createPageInfo(2, 0, 250, 100)).toMatchObject({
      page: 2,
      pageSize: 100,
      from: 101,
      to: 200,
      hasPrevious: true,
      hasNext: true,
      truncated: true,
    });
  });

  it("does not mark ordinary paged results as truncated", () => {
    expect(createPageInfo(1, 20, 250, 100)).toMatchObject({
      pageSize: 20,
      totalPages: 13,
      truncated: false,
    });
  });

  it("clamps an out-of-range page by default and keeps it when clamping is off", () => {
    expect(createPageInfo(9, 10, 25)).toMatchObject({ page: 3, from: 21, to: 25, hasNext: false });
    expect(createPageInfo(9, 10, 25, 200, { clampPage: false })).toMatchObject({
      page: 9,
      totalPages: 3,
      from: 0,
      to: 0,
      hasPrevious: true,
      hasNext: false,
    });
    expect(createPageInfo(2, 10, 0, 200, { clampPage: false })).toMatchObject({ page: 2, from: 0, to: 0 });
  });
});
