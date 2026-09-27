import { isSafeRepositoryUrl } from "@work-intelligence/core";

export const EDITOR_PROTOCOLS = ["none", "vscode", "cursor"] as const;
export type EditorProtocol = (typeof EDITOR_PROTOCOLS)[number];

export const editorProtocolLabels: Record<EditorProtocol, string> = {
  none: "不使用",
  vscode: "VS Code",
  cursor: "Cursor",
};

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const WINDOWS_DRIVE = /^[a-z]:$/i;

function slashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * The absolute path of a changed file inside the project root, or undefined when it would leave the root.
 * Accepts project-relative paths and absolute paths under the root; ".." segments are never followed.
 */
export function pathInsideProject(rootPath: string, filePath: string): string | undefined {
  const root = slashes(rootPath.trim()).replace(/\/+$/, "");
  let path = slashes(filePath.trim());
  if (!root || !path || path.includes("\0")) return undefined;
  const absolute = path.startsWith("/") || /^[a-z]:\//i.test(path);
  if (absolute) {
    const sameRoot = WINDOWS_DRIVE.test(root.slice(0, 2))
      ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      : path.startsWith(`${root}/`);
    if (!sameRoot) return undefined;
    path = path.slice(root.length + 1);
  }
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return undefined;
  return `${root}/${segments.join("/")}`;
}

/** A vscode:// or cursor:// link that opens the file, or undefined when no editor is chosen or the path is unsafe. */
export function editorFileUrl(editor: EditorProtocol, rootPath: string, filePath: string): string | undefined {
  if (editor === "none") return undefined;
  const absolute = pathInsideProject(rootPath, filePath);
  if (!absolute) return undefined;
  // Encode each segment (spaces, #, ?) but keep a Windows drive letter readable.
  const encoded = absolute
    .split("/")
    .map((segment) => (WINDOWS_DRIVE.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `${editor}://file${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

/** A link to the commit on the repository host, or undefined without a safe https URL and a commit SHA. */
export function commitUrl(repositoryUrl: string | undefined, commitSha: string | undefined): string | undefined {
  if (!repositoryUrl || !commitSha || !COMMIT_SHA.test(commitSha) || !isSafeRepositoryUrl(repositoryUrl)) {
    return undefined;
  }
  const url = new URL(repositoryUrl);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`;
  // Bitbucket uses /commits/<sha>; GitHub, GitLab, Gitea, and most others use /commit/<sha>.
  const segment = url.hostname === "bitbucket.org" ? "commits" : "commit";
  return `${base}/${segment}/${commitSha.toLowerCase()}`;
}
