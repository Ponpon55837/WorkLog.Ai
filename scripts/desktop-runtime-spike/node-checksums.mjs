/**
 * SHA-256 of every official Node.js archive the runtime build may download, pinned in the repository: the build trusts
 * these values, not whatever nodejs.org serves next to the archive (a swapped archive would come with a matching
 * SHASUMS256.txt). To add a version, copy its lines from the SHASUMS256.txt that nodejs.org publishes for it and check
 * them against the signed SHASUMS256.txt.asc, then add them here in the same commit that changes DEFAULT_NODE_VERSION.
 */
export const PINNED_NODE_SHA256 = {
  "v24.22.3": {
    "node-v24.22.3-darwin-arm64.tar.gz": "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
    "node-v24.22.3-darwin-x64.tar.gz": "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
    "node-v24.22.3-linux-arm64.tar.gz": "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
    "node-v24.22.3-linux-x64.tar.gz": "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
    "node-v24.22.3-win-arm64.zip": "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14",
    "node-v24.22.3-win-x64.zip": "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f",
  },
};

/** The pinned hash of `archiveName` in Node.js `version`, or undefined when that archive is not pinned. */
export function pinnedNodeSha256(version, archiveName) {
  return PINNED_NODE_SHA256[version]?.[archiveName];
}
