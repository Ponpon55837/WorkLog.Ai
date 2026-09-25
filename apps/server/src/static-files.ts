import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { staticFileRequestPathSchema } from "@work-intelligence/schema";

const contentTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

type StaticFile = { path: string; size: number };
type PathResolution = { kind: "file"; file: StaticFile } | { kind: "missing" } | { kind: "unsafe" };

/** Applies the browser security policy used when the built Web UI and API share an origin. */
export function applyProductionSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "style-src-elem 'self'",
      "style-src-attr 'unsafe-inline'",
    ].join("; "),
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

/** Serves built assets safely and falls back to index.html for client-side routes. */
export function createStaticFilesHandler(directory: string) {
  const rootPromise = realpath(directory);

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return false;
    }

    const rawTarget = request.url ?? "/";
    const queryStart = rawTarget.indexOf("?");
    const rawPath = queryStart < 0 ? rawTarget : rawTarget.slice(0, queryStart);
    const validatedPath = staticFileRequestPathSchema.safeParse(rawPath);
    if (!validatedPath.success || rawPath.startsWith("//")) {
      sendStaticError(response, 400, "Invalid path.");
      return true;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(validatedPath.data);
    } catch {
      sendStaticError(response, 400, "Invalid path.");
      return true;
    }

    const segments = decodedPath.split("/").filter(Boolean);
    if (
      decodedPath.includes("\\") ||
      decodedPath.includes("\0") ||
      decodedPath.split("").some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      }) ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      sendStaticError(response, 400, "Invalid path.");
      return true;
    }

    const root = await rootPromise;
    const relativePath = decodedPath.replace(/^\/+/, "");
    const candidate = await resolveStaticFile(root, resolve(root, relativePath));
    if (candidate.kind === "unsafe") {
      sendStaticError(response, 400, "Invalid path.");
      return true;
    }
    if (candidate.kind === "file") {
      await sendStaticFile(request, response, candidate.file, root, false);
      return true;
    }

    const firstSegment = segments[0]?.toLowerCase();
    const canFallback = extname(decodedPath) === "" && firstSegment !== "assets" && acceptsHtml(request.headers.accept);
    if (canFallback) {
      const fallback = await resolveStaticFile(root, resolve(root, "index.html"));
      if (fallback.kind === "file") {
        await sendStaticFile(request, response, fallback.file, root, true);
        return true;
      }
      if (fallback.kind === "unsafe") {
        sendStaticError(response, 500, "Web files are not available.");
        return true;
      }
    }

    sendStaticError(response, 404, "Not found.");
    return true;
  };
}

async function resolveStaticFile(root: string, candidate: string): Promise<PathResolution> {
  try {
    const canonicalPath = await realpath(candidate);
    const relativePath = relative(root, canonicalPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return { kind: "unsafe" };
    }
    const info = await stat(canonicalPath);
    return info.isFile() ? { kind: "file", file: { path: canonicalPath, size: info.size } } : { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
}

async function sendStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: StaticFile,
  root: string,
  isSpaFallback: boolean,
): Promise<void> {
  const extension = extname(file.path).toLowerCase();
  const assetPath = relative(root, file.path);
  const isHashedAsset = assetPath.split(sep)[0] === "assets" && /-[a-z\d_-]{8,}\.[a-z\d]+$/i.test(basename(file.path));
  response.writeHead(200, {
    "Cache-Control":
      isSpaFallback || basename(file.path) === "index.html"
        ? "no-store"
        : isHashedAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache",
    "Content-Length": String(file.size),
    "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(file.path), response);
}

function acceptsHtml(header: string | undefined): boolean {
  return Boolean(header?.split(",").some((type) => type.trim().toLowerCase().startsWith("text/html")));
}

function sendStaticError(response: ServerResponse, statusCode: number, message: string): void {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}
