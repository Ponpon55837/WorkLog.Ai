/** The one repository the update check talks about. The endpoint, the link validation and the fallback link derive from it. */
export const RELEASE_REPO_SLUG = "Ponpon55837/WorkLog.Ai";

/** The origin of the GitHub REST API; a test build may point the check at a local fake server instead (apps/desktop config). */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** How many releases one check asks for; the newest stable one is picked from them. */
export const RELEASES_PER_PAGE = 20;

/** The only request headers the check sends (the transport adds its own: host, connection, accept-encoding, ...). */
export const UPDATE_REQUEST_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "WorkIntelligence-UpdateCheck",
} as const;

/** Total time one check may take (request and body together). */
export const UPDATE_TIMEOUT_MS = 10_000;

/** The largest response body the check reads; more than this is an error, not a truncated read. */
export const UPDATE_MAX_RESPONSE_BYTES = 1024 * 1024;

/** `GET` URL of the release list. */
export function releasesApiUrl(slug: string = RELEASE_REPO_SLUG, origin: string = GITHUB_API_ORIGIN): string {
  return `${origin}/repos/${slug}/releases?per_page=${RELEASES_PER_PAGE}`;
}

/** The repository's releases page: the fallback link when a release's own page cannot be trusted. */
export function releasesPageUrl(slug: string = RELEASE_REPO_SLUG): string {
  return `https://github.com/${slug}/releases`;
}

/** The page of one release; `tag` must already be a validated `vX.Y.Z`. */
export function releaseTagUrl(tag: string, slug: string = RELEASE_REPO_SLUG): string {
  return `${releasesPageUrl(slug)}/tag/${tag}`;
}

/** The download link of one release asset; `tag` and `name` must already be validated. */
export function releaseAssetUrl(tag: string, name: string, slug: string = RELEASE_REPO_SLUG): string {
  return `${releasesPageUrl(slug)}/download/${tag}/${name}`;
}
