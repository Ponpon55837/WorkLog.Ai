import { z } from "zod";
import { RELEASE_REPO_SLUG, releaseAssetUrl, releaseTagUrl, releasesPageUrl } from "./constants.js";
import type { UpdateCheckResult, UpdateLinks } from "./result.js";
import { sanitizeNotes } from "./sanitize.js";
import { installerAssetFor, isOurReleaseUrl } from "./urls.js";
import { isNewerThanRunning, parseReleaseTag, parseRunningVersion, compareSemver, type ParsedTag } from "./version.js";

/** Only the fields the check needs; everything else in the response is dropped. */
export const releaseListSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
  }),
);
export type ReleaseList = z.infer<typeof releaseListSchema>;

/** The answer and the links main keeps for `openUpdateLink`. */
export interface UpdateOutcome {
  readonly result: UpdateCheckResult;
  readonly links: UpdateLinks;
}

export interface EvaluateInputs {
  readonly currentVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly slug?: string;
}

const NO_LINKS: UpdateLinks = { asset: null, page: null };

function publishedIso(value: string | null | undefined): string | null {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** The highest stable release: not a draft, not a pre-release, and a tag that is exactly `vX.Y.Z`. */
function newestStable(releases: ReleaseList): { release: ReleaseList[number]; tag: ParsedTag } | null {
  let best: { release: ReleaseList[number]; tag: ParsedTag } | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const tag = parseReleaseTag(release.tag_name);
    if (tag && (best === null || compareSemver(tag, best.tag) > 0)) best = { release, tag };
  }
  return best;
}

/** Decides what the release list means for the running version, and which links go with it. */
export function evaluateReleases(releases: ReleaseList, inputs: EvaluateInputs): UpdateOutcome {
  const slug = inputs.slug ?? RELEASE_REPO_SLUG;
  const running = parseRunningVersion(inputs.currentVersion);
  if (!running) return { result: { kind: "error", reason: "bad-version" }, links: NO_LINKS };
  const newest = newestStable(releases);
  if (!newest || !isNewerThanRunning(newest.tag, running)) {
    return { result: { kind: "up-to-date", current: inputs.currentVersion }, links: NO_LINKS };
  }
  const { release, tag } = newest;
  // A release page that is not the one this tag has means the response is odd: the releases list is the safe link.
  const page = release.html_url === releaseTagUrl(tag.tag, slug) ? release.html_url : releasesPageUrl(slug);
  const wanted = installerAssetFor(tag.version, inputs.platform, inputs.arch);
  const url = wanted ? releaseAssetUrl(tag.tag, wanted.name, slug) : null;
  const offered =
    wanted &&
    url &&
    isOurReleaseUrl(url, slug) &&
    release.assets.some((asset) => asset.name === wanted.name && asset.browser_download_url === url)
      ? { platform: wanted.platform, url }
      : null;
  const notes = sanitizeNotes(release.body ?? "");
  return {
    result: {
      kind: "newer",
      current: inputs.currentVersion,
      version: tag.version,
      publishedAt: publishedIso(release.published_at),
      notes: notes.text,
      notesTruncated: notes.truncated,
      asset: offered ? { platform: offered.platform } : null,
    },
    links: { asset: offered?.url ?? null, page: isOurReleaseUrl(page, slug) ? page : null },
  };
}
