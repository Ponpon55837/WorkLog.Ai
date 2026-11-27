export const RELEASE_REPO_SLUG = "Ponpon55837/WorkLog.Ai";

export const GITHUB_API_ORIGIN = "https://api.github.com";

export const RELEASES_PER_PAGE = 20;

export const UPDATE_REQUEST_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "WorkIntelligence-UpdateCheck",
} as const;

export const UPDATE_TIMEOUT_MS = 10_000;

export const UPDATE_MAX_RESPONSE_BYTES = 1024 * 1024;

export function releasesApiUrl(slug: string = RELEASE_REPO_SLUG, origin: string = GITHUB_API_ORIGIN): string {
  return `${origin}/repos/${slug}/releases?per_page=${RELEASES_PER_PAGE}`;
}

export function releasesPageUrl(slug: string = RELEASE_REPO_SLUG): string {
  return `https://github.com/${slug}/releases`;
}

export function releaseTagUrl(tag: string, slug: string = RELEASE_REPO_SLUG): string {
  return `${releasesPageUrl(slug)}/tag/${tag}`;
}

export function releaseAssetUrl(tag: string, name: string, slug: string = RELEASE_REPO_SLUG): string {
  return `${releasesPageUrl(slug)}/download/${tag}/${name}`;
}
