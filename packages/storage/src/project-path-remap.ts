import type { ProjectPathRemap } from "@work-intelligence/core";

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimTrailingSeparators(value: string): string {
  if (/^[A-Za-z]:[\\/]$/.test(value) || value === "/" || value === "\\") {
    return value;
  }
  return value.replace(/[\\/]+$/, "");
}

/** Replaces a complete path prefix and converts the remaining separators for a different target platform. */
export function remapPathPrefix(value: string, mapping: ProjectPathRemap): string {
  const source = trimTrailingSeparators(normalizeSeparators(mapping.from));
  const candidate = normalizeSeparators(value);
  const windowsSource = isWindowsPath(mapping.from);
  const comparableSource = windowsSource ? source.toLowerCase() : source;
  const comparableCandidate = windowsSource ? candidate.toLowerCase() : candidate;
  const sourcePrefix = source.endsWith("/") ? source : `${source}/`;
  const comparablePrefix = windowsSource ? sourcePrefix.toLowerCase() : sourcePrefix;

  if (comparableCandidate !== comparableSource && !comparableCandidate.startsWith(comparablePrefix)) {
    return value;
  }

  const suffix = comparableCandidate === comparableSource ? "" : candidate.slice(sourcePrefix.length);
  if (suffix.length === 0) {
    return mapping.to;
  }

  const targetIsWindows = isWindowsPath(mapping.to);
  const separator = targetIsWindows ? "\\" : "/";
  const target = trimTrailingSeparators(mapping.to);
  const convertedSuffix = targetIsWindows ? suffix.replace(/\//g, "\\") : suffix.replace(/\\/g, "/");
  const needsSeparator = !target.endsWith(separator);
  return `${target}${needsSeparator ? separator : ""}${convertedSuffix}`;
}
