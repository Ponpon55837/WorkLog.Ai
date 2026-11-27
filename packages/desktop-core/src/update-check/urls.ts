import { RELEASE_REPO_SLUG } from "./constants.js";
import { parseReleaseTag } from "./version.js";
import type { UpdatePlatform } from "./result.js";

const ASSET_NAME_PATTERN = /^Work-Intelligence-(\d+\.\d+\.\d+)-(?:win-x64-setup\.exe|mac-arm64\.dmg|mac-x64\.dmg)$/;

export interface InstallerAsset {
  readonly name: string;
  readonly platform: UpdatePlatform;
}

export function installerAssetFor(version: string, platform: string, arch: string): InstallerAsset | null {
  if (platform === "win32" && arch === "x64") {
    return { name: `Work-Intelligence-${version}-win-x64-setup.exe`, platform: "windows" };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return { name: `Work-Intelligence-${version}-mac-${arch}.dmg`, platform: "macos" };
  }
  return null;
}

export function isOurReleaseUrl(url: string, slug: string = RELEASE_REPO_SLUG): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Re-serialization must give back the same text: it rejects `..`, `\`, upper-case hosts and default ports; an empty `?` or `#` survives it, so those are refused by text.
  if (
    url.includes("?") ||
    url.includes("#") ||
    parsed.href !== url ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com"
  )
    return false;
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "" || parsed.pathname.includes("%")) return false;
  const base = `/${slug}/releases`;
  const { pathname } = parsed;
  if (pathname === base) return true;
  if (pathname.startsWith(`${base}/tag/`)) return parseReleaseTag(pathname.slice(base.length + 5)) !== null;
  if (!pathname.startsWith(`${base}/download/`)) return false;
  const [tag, name, ...rest] = pathname.slice(base.length + 10).split("/");
  const parsedTag = parseReleaseTag(tag ?? "");
  const asset = ASSET_NAME_PATTERN.exec(name ?? "");
  return parsedTag !== null && rest.length === 0 && asset?.[1] === parsedTag.version;
}
