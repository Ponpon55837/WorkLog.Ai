import type { PageInfo } from "@work-intelligence/core";

export function createPageInfo(
  pageValue: number | undefined,
  pageSizeValue: number | undefined,
  total: number,
  maxPageSize = 200,
): PageInfo {
  const requestedPageSize = Math.trunc(pageSizeValue ?? 20);
  const showAll = requestedPageSize === 0;
  const safeMaxPageSize = Math.max(Math.trunc(maxPageSize), 1);
  const pageSize = showAll
    ? Math.min(Math.max(total, 1), safeMaxPageSize)
    : Math.min(Math.max(requestedPageSize, 1), safeMaxPageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(pageValue ?? 1), 1), totalPages);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = total === 0 ? 0 : Math.min(page * pageSize, total);
  return {
    page,
    pageSize,
    total,
    totalPages,
    from,
    to,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    truncated: showAll && total > safeMaxPageSize,
  };
}
