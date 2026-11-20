import fs from "node:fs/promises";
import path from "node:path";
import ignoreModule, { type Ignore } from "ignore";

// Handle both ESM default and CJS interop for the `ignore` package.
const createIgnore: () => Ignore =
  typeof ignoreModule === "function"
    ? (ignoreModule as unknown as () => Ignore)
    : (ignoreModule as unknown as { default: () => Ignore }).default;

export interface WalkedFile {
  absPath: string;
  relPath: string; // POSIX-style forward slashes relative to rootDir
  dir: string; // POSIX-style directory relative to rootDir ("." for root)
  ext: string; // lowercase extension without dot, or ""
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  rootDir: string;
  subpath?: string;
  extensions?: string[];
  maxFileBytes?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
}

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  "dist",
  "dist-test",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "target",
  "vendor",
  "coverage",
  ".nyc_output",
  ".idea",
  ".vscode",
  ".gradle",
  "Pods",
]);

const DEFAULT_IGNORED_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "go.sum",
  "composer.lock",
  "gemfile.lock",
  "flake.lock",
  ".ds_store",
  "thumbs.db",
]);

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svgz",
  "avif",
  "heic",
  "tif",
  "tiff",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "exe",
  "dll",
  "so",
  "dylib",
  "a",
  "o",
  "obj",
  "class",
  "jar",
  "war",
  "pyc",
  "pyo",
  "wasm",
  "sqlite",
  "sqlite3",
  "db",
  "bin",
  "dat",
  "parquet",
  "arrow",
  "onnx",
  "pt",
  "pth",
  "safetensors",
  "gguf",
  "pb",
]);

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isMinifiedOrGenerated(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (DEFAULT_IGNORED_FILES.has(lower)) return true;
  if (lower.endsWith(".lock") || lower.endsWith(".lockb")) return true;
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".min.mjs")) {
    return true;
  }
  if (lower.endsWith(".map") && (lower.endsWith(".js.map") || lower.endsWith(".css.map"))) {
    return true;
  }
  if (lower.endsWith(".d.ts.map")) return true;
  return false;
}

async function readIgnoreFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

interface ScopedIgnore {
  basePosix: string; // "" for root, or "a/b"
  matcher: Ignore;
}

function isIgnoredByStack(
  relPosix: string,
  isDir: boolean,
  stack: ScopedIgnore[]
): boolean {
  let ignored = false;
  for (const layer of stack) {
    let subRel = relPosix;
    if (layer.basePosix !== "") {
      const prefix = `${layer.basePosix}/`;
      if (!relPosix.startsWith(prefix)) continue;
      subRel = relPosix.slice(prefix.length);
    }
    if (!subRel) continue;
    const candidate = isDir ? `${subRel}/` : subRel;
    const result = layer.matcher.test(candidate);
    if (result.ignored) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }
  return ignored;
}

export async function walkRepoFiles(options: WalkOptions): Promise<WalkedFile[]> {
  const rootDir = path.resolve(options.rootDir);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const respectGitignore = options.respectGitignore ?? true;
  const includeHidden = options.includeHidden ?? false;

  const allowedExtensions =
    options.extensions && options.extensions.length > 0
      ? new Set(options.extensions.map((e) => e.replace(/^\./, "").toLowerCase()))
      : null;

  const startDir = options.subpath
    ? path.resolve(rootDir, options.subpath)
    : rootDir;

  // Ensure startDir exists and is inside rootDir
  const relStart = path.relative(rootDir, startDir);
  if (relStart.startsWith("..") || path.isAbsolute(relStart)) {
    throw new Error(`Subpath "${options.subpath}" escapes repository root "${rootDir}".`);
  }

  const rootIgnoreStack: ScopedIgnore[] = [];
  if (respectGitignore) {
    const gitExclude = await readIgnoreFile(path.join(rootDir, ".git", "info", "exclude"));
    if (gitExclude) {
      rootIgnoreStack.push({ basePosix: "", matcher: createIgnore().add(gitExclude) });
    }
    const rootGitignore = await readIgnoreFile(path.join(rootDir, ".gitignore"));
    if (rootGitignore) {
      rootIgnoreStack.push({ basePosix: "", matcher: createIgnore().add(rootGitignore) });
    }
    const rootNimbleignore = await readIgnoreFile(path.join(rootDir, ".nimbleignore"));
    if (rootNimbleignore) {
      rootIgnoreStack.push({ basePosix: "", matcher: createIgnore().add(rootNimbleignore) });
    }

    // Load intermediate .gitignore files between rootDir and startDir
    if (relStart && relStart !== ".") {
      const parts = toPosix(relStart).split("/");
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        const nestedGi = await readIgnoreFile(path.join(rootDir, acc, ".gitignore"));
        if (nestedGi) {
          rootIgnoreStack.push({ basePosix: acc, matcher: createIgnore().add(nestedGi) });
        }
        const nestedNi = await readIgnoreFile(path.join(rootDir, acc, ".nimbleignore"));
        if (nestedNi) {
          rootIgnoreStack.push({ basePosix: acc, matcher: createIgnore().add(nestedNi) });
        }
      }
    }
  }

  const results: WalkedFile[] = [];

  async function visit(currentAbs: string, ignoreStack: ScopedIgnore[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }

    const relDir = toPosix(path.relative(rootDir, currentAbs));
    let localStack = ignoreStack;

    if (respectGitignore && currentAbs !== rootDir && currentAbs !== startDir) {
      const [gi, ni] = await Promise.all([
        readIgnoreFile(path.join(currentAbs, ".gitignore")),
        readIgnoreFile(path.join(currentAbs, ".nimbleignore")),
      ]);
      if (gi || ni) {
        localStack = [...ignoreStack];
        if (gi) {
          localStack.push({ basePosix: relDir, matcher: createIgnore().add(gi) });
        }
        if (ni) {
          localStack.push({ basePosix: relDir, matcher: createIgnore().add(ni) });
        }
      }
    }

    const subdirs: string[] = [];

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const name = entry.name;
      const entryAbs = path.join(currentAbs, name);
      const relPosix = relDir ? `${relDir}/${name}` : name;

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(name)) continue;
        if (!includeHidden && name.startsWith(".") && name !== ".github") continue;
        if (respectGitignore && isIgnoredByStack(relPosix, true, localStack)) continue;
        subdirs.push(entryAbs);
        continue;
      }

      if (!entry.isFile()) continue;
      if (isMinifiedOrGenerated(name)) continue;
      if (!includeHidden && name.startsWith(".") && name !== ".env.example") continue;
      if (respectGitignore && isIgnoredByStack(relPosix, false, localStack)) continue;

      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : "";
      if (ext && BINARY_EXTENSIONS.has(ext)) continue;
      if (allowedExtensions && !allowedExtensions.has(ext)) continue;

      let stat;
      try {
        stat = await fs.stat(entryAbs);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > maxFileBytes) continue;

      results.push({
        absPath: entryAbs,
        relPath: relPosix,
        dir: relDir || ".",
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }

    // Visit subdirectories with modest parallelism
    if (subdirs.length > 0) {
      await Promise.all(subdirs.map((d) => visit(d, localStack)));
    }
  }

  await visit(startDir, rootIgnoreStack);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}
