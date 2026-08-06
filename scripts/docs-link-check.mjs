import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";

/**
 * Lightweight documentation link checker (Node built-in modules only).
 *
 * Usage: node scripts/docs-link-check.mjs [path]
 * Without arguments it checks the repository `docs/` directory and the
 * repository `README.md`. With an argument it checks that file or directory.
 * Verifies that:
 *   - every referenced local Markdown file exists;
 *   - every referenced heading anchor exists;
 *   - malformed (double/empty-hash) anchors fail.
 * Exits with code 0 on success and 1 on any broken link.
 */

export async function collectMarkdownFiles(target) {
  const info = await stat(target);
  if (info.isFile()) {
    return [".md", ".markdown"].includes(extname(target)) ? [target] : [];
  }
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(fullPath)));
    } else if (entry.isFile() && [".md", ".markdown"].includes(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

/** GitHub-style heading slug: lowercase, strip non-alphanumerics except spaces/hyphens, spaces -> hyphens. */
export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** Collect the set of acceptable anchors for a Markdown document. */
export function collectAnchors(markdown) {
  const anchors = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const raw = match[2].trim();
      anchors.add(raw.toLowerCase());
      anchors.add(slugifyHeading(raw));
    }
  }
  return anchors;
}

/** Extract inline link targets `[text](target ...)`. */
export function extractLinkTargets(markdown) {
  const targets = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    let target = match[1].trim();
    target = target.replace(/\s+"[^"]*"$/, "").trim();
    if (target) targets.push(target);
  }
  return targets;
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("./") && !target.startsWith("../");
}

function displayPath(rootDir, file) {
  const rel = normalize(relative(rootDir, file));
  return rel === "" ? basename(file) : rel.replace(/\\/g, "/");
}

export async function checkDocs(rootDir) {
  return checkFileSet(await collectMarkdownFiles(rootDir), rootDir);
}

export async function checkRoots(roots) {
  const files = new Set();
  for (const root of roots) {
    for (const file of await collectMarkdownFiles(root)) files.add(file);
  }
  return checkFileSet([...files], roots[0]);
}

export async function checkFileSet(files, rootDir) {
  const sorted = [...files].sort();
  const contents = new Map();
  for (const file of sorted) {
    contents.set(file, await readFile(file, "utf8"));
  }

  const errors = [];
  const rel = (file) => displayPath(rootDir, file);
  let linksChecked = 0;

  for (const file of sorted) {
    const text = contents.get(file);
    for (const target of extractLinkTargets(text)) {
      linksChecked += 1;
      if (isExternal(target)) continue;

      const parts = target.split("#");
      if (parts.length > 2 || (parts.length === 2 && parts[1] === "")) {
        errors.push(`${rel(file)}: malformed anchor in link '${target}' (multiple or empty hash).`);
        continue;
      }
      const pathPart = parts[0];
      const fragmentPart = parts.length === 2 ? parts[1] : "";

      let targetFile = file;
      if (pathPart !== "") {
        targetFile = normalize(join(dirname(file), pathPart));
        if (!extname(targetFile) && contents.has(targetFile + ".md")) {
          targetFile += ".md";
        }
        if (!contents.has(targetFile)) {
          errors.push(`${rel(file)}: missing target file for link '${target}' -> ${rel(targetFile)}`);
          continue;
        }
      }

      if (fragmentPart) {
        let decoded = fragmentPart;
        try {
          decoded = decodeURIComponent(fragmentPart);
        } catch {
          // keep the raw fragment if it is not valid percent-encoding
        }
        const anchors = collectAnchors(contents.get(targetFile));
        if (!anchors.has(decoded.toLowerCase()) && !anchors.has(slugifyHeading(decoded))) {
          errors.push(
            `${rel(file)}: missing heading anchor '${fragmentPart}' in ${rel(targetFile)} for link '${target}'.`
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, files: sorted.length, links: linksChecked };
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const argvPath = process.argv[2];
const roots = argvPath
  ? [resolve(process.cwd(), argvPath)]
  : [join(repoRoot, "docs"), join(repoRoot, "README.md")];
const result = await checkRoots(roots);

for (const error of result.errors) {
  process.stdout.write(`ERROR: ${error}\n`);
}
process.stdout.write(
  `docs:check ${result.ok ? "OK" : "FAILED"} (${result.files} file(s), ${result.links} link(s) checked)\n`
);
if (!result.ok) {
  process.exitCode = 1;
}