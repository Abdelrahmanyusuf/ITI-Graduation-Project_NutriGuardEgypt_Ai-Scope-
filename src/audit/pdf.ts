/**
 * Minimal PDF parser for the WHO Guidelines audit.
 *
 * Scope: extract page count, Info dictionary metadata (Title/Author/CreationDate),
 * and text content from page content streams. Supports FlateDecode and
 * uncompressed content, including objects stored in compressed object streams
 * (/ObjStm). Object scanning is length-aware (/Length) to avoid misreading
 * binary stream payloads. Anything not assessable is reported as
 * not_assessed by the caller, never guessed.
 */

import { inflateSync } from "node:zlib";

export interface PdfInfo {
  title: string | null;
  author: string | null;
  creationDate: string | null;
  modDate: string | null;
}

export interface PdfResult {
  pageCount: number | null;
  info: PdfInfo;
  text: string;
  extractionAvailable: boolean;
  errors: string[];
  warnings: string[];
}

interface PdfObject {
  dict: string;
  stream: string | null;
}

const OBJ_HEADER_RE = /(\d+)\s+(\d+)\s+obj\s*\n/g;

function decodePdfString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("(") && t.endsWith(")")) {
    const inner = t.slice(1, -1);
    return inner
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\b/g, "\b")
      .replace(/\\f/g, "\f")
      .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
  }
  if (t.startsWith("<") && t.endsWith(">")) {
    const hex = t.slice(1, -1).replace(/\s+/g, "");
    if (hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex)) {
      const buf = Buffer.from(hex, "hex");
      if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        try {
          return new TextDecoder("utf-16be").decode(new Uint8Array(buf.slice(2)));
        } catch {
          return "";
        }
      }
      let out = "";
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return out;
    }
  }
  return t;
}

function dictValue(dict: string, key: string): string | null {
  const re = new RegExp(`\\/${key}\\s+([^\\s\\[\\]{}<>\\(]+|<<[\\s\\S]*?>>|\\([\\s\\S]*?\\)|\\[\\s*\\])`);
  const m = re.exec(dict);
  return m ? m[1].trim() : null;
}

/** Return a reference like `2 0 R` for a key, when present. */
function dictRef(dict: string, key: string): string | null {
  const re = new RegExp(`\\/${key}\\s+(\\d+)\\s+\\d+\\s+R`);
  const m = re.exec(dict);
  return m ? `${m[1]} 0 R` : null;
}

function dictLength(dict: string): number | null {
  const v = dictValue(dict, "Length");
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Length-aware scanner of top-level objects (not object-stream contents). */
function scanTopLevelObjects(s: string): Map<string, PdfObject> {
  const objects = new Map<string, PdfObject>();
  let m: RegExpExecArray | null;
  OBJ_HEADER_RE.lastIndex = 0;
  while ((m = OBJ_HEADER_RE.exec(s)) !== null) {
    const key = `${m[1]} ${m[2]}`;
    const start = OBJ_HEADER_RE.lastIndex;
    const endObj = s.indexOf("\nendobj", start);
    if (endObj < 0) break;

    let dict = "";
    let stream: string | null = null;
    const streamMarker = s.indexOf("stream", start);
    if (streamMarker >= 0 && streamMarker < endObj) {
      dict = s.slice(start, streamMarker);
      const contentStart = s[streamMarker + 6] === "\r" && s[streamMarker + 7] === "\n" ? streamMarker + 8 : streamMarker + 7;
      const len = dictLength(dict);
      const endStream = s.indexOf("\nendstream", contentStart);
      if (len !== null && contentStart + len <= s.length) {
        stream = s.slice(contentStart, contentStart + len);
      } else if (endStream >= 0) {
        stream = s.slice(contentStart, endStream);
      }
    } else {
      dict = s.slice(start, endObj);
    }
    objects.set(key, { dict, stream });
    OBJ_HEADER_RE.lastIndex = endObj + 7;
  }
  return objects;
}

/** Expand /ObjStm objects into the object map. */
function expandObjectStreams(objects: Map<string, PdfObject>): void {
  for (const obj of objects.values()) {
    if (obj.stream === null) continue;
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    let inflated: string;
    try {
      inflated = inflateSync(Buffer.from(obj.stream, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    const firstM = /\/First\s+(\d+)/.exec(obj.dict);
    const nM = /\/N\s+(\d+)/.exec(obj.dict);
    if (!firstM || !nM) continue;
    const first = parseInt(firstM[1], 10);
    const n = parseInt(nM[1], 10);
    if (!Number.isFinite(first) || !Number.isFinite(n) || first < 0 || first >= inflated.length) continue;

    const header = inflated.slice(0, first);
    const nums = header.match(/\d+/g) ?? [];
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i + 1 < nums.length && pairs.length < n; i += 2) {
      pairs.push([parseInt(nums[i], 10), parseInt(nums[i + 1], 10)]);
    }
    const offsets = pairs.map(([, offset]) => offset);
    for (const [objnum, offset] of pairs) {
      const start = first + offset;
      const next = offsets.find((o) => o > offset);
      const contentEnd = next === undefined ? inflated.length : first + next;
      objects.set(`${objnum} 0`, { dict: inflated.slice(start, contentEnd), stream: null });
    }
  }
}

/** Extract text-showing operators from a content stream. */
function extractTextFromContent(content: string): string {
  const parts: string[] = [];
  // Hex strings <...> (from TJ/Tj text arrays) -> decode to characters when printable ASCII.
  const hexRe = /<([0-9a-fA-F]{2}(?:\s*[0-9a-fA-F]{2})+)\s*>/g;
  let h: RegExpExecArray | null;
  while ((h = hexRe.exec(content)) !== null) {
    const bytes = h[1].replace(/\s+/g, "");
    const buf = Buffer.from(bytes, "hex");
    let text: string;
    if (buf.length % 2 === 0 && buf[0] === 0x00 && buf[2] === 0x00) {
      try {
        text = new TextDecoder("utf-16be").decode(new Uint8Array(buf));
      } catch {
        text = "";
      }
    } else {
      text = "";
      for (const b of buf) text += String.fromCharCode(b);
    }
    if (/^[ -~]+$/.test(text)) parts.push(text);
  }
  // Literal strings (...) shown with Tj / TJ.
  if (parts.length === 0) {
    const strRe = /\(((?:[^()\\]|\\.)*)\)\s*(Tj|TJ|'|")/g;
    let s: RegExpExecArray | null;
    while ((s = strRe.exec(content)) !== null) {
      parts.push(`(${s[1]})`);
    }
  }
  if (parts.length === 0) {
    const tjRe = /\[([\s\S]*?)\]\s*TJ/g;
    let tm: RegExpExecArray | null;
    while ((tm = tjRe.exec(content)) !== null) {
      const strs = tm[1].match(/\(((?:[^()\\]|\\.)*)\)/g) ?? [];
      parts.push(...strs);
    }
  }
  return parts.map((p) => decodePdfString(p)).filter((p) => p.trim() !== "").join(" ");
}

export function parsePdf(bytes: Uint8Array): PdfResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = Buffer.from(bytes).toString("latin1");

  if (!s.startsWith("%PDF-")) {
    return {
      pageCount: null,
      info: { title: null, author: null, creationDate: null, modDate: null },
      text: "",
      extractionAvailable: false,
      errors: ["not a PDF (missing %PDF- header)"],
      warnings: [],
    };
  }

  const objects = scanTopLevelObjects(s);
  expandObjectStreams(objects);

  const deref = (ref: string | null): PdfObject | null => {
    if (!ref) return null;
    const m2 = /^(\d+)\s+(\d+)\s+R$/.exec(ref.trim());
    if (!m2) return null;
    return objects.get(`${m2[1]} ${m2[2]}`) ?? null;
  };

  const inflate = (stream: string): string => {
    try {
      return inflateSync(Buffer.from(stream, "latin1")).toString("latin1");
    } catch {
      errors.push("FlateDecode stream failed to decompress");
      return "";
    }
  };

  // Trailer / Info.
  const infoObj = dictRef(s, "Info") !== null ? deref(dictRef(s, "Info")) : null;
  const info: PdfInfo = { title: null, author: null, creationDate: null, modDate: null };
  if (infoObj) {
    const d = infoObj.dict;
    const title = dictValue(d, "Title");
    const author = dictValue(d, "Author");
    const created = dictValue(d, "CreationDate");
    const modified = dictValue(d, "ModDate");
    if (title) info.title = decodePdfString(title);
    if (author) info.author = decodePdfString(author);
    if (created) info.creationDate = decodePdfString(created);
    if (modified) info.modDate = decodePdfString(modified);
  } else {
    warnings.push("no /Info object found");
  }

  // Page tree.
  const root = dictRef(s, "Root") !== null ? deref(dictRef(s, "Root")) : null;
  const seen = new Set<string>();

  const countPages = (node: PdfObject, refKey: string): number | null => {
    if (seen.has(refKey)) return 0;
    seen.add(refKey);
    const type = dictValue(node.dict, "Type");
    if (type === "/Page") return 1;
    // Fast path: /Count on a /Pages node (object streams may hold it).
    if (/\/Type\s*\/Pages/.test(node.dict)) {
      const c = dictValue(node.dict, "Count");
      if (c && /^\d+$/.test(c)) return parseInt(c, 10);
    }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(node.dict);
    if (!kids) return null;
    const refs = kids[1].match(/\d+\s+\d+\s+R/g) ?? [];
    if (refs.length === 0) return null;
    let total = 0;
    for (const ref of refs) {
      const child = deref(ref);
      if (!child) return null;
      const c = countPages(child, ref.trim());
      if (c === null) return null;
      total += c;
    }
    return total;
  };

  let pageCount: number | null = null;
  if (root) {
    const pagesRef = dictRef(root.dict, "Pages");
    const pages = deref(pagesRef);
    if (pages) pageCount = countPages(pages, (pagesRef ?? "").trim());
    else errors.push("catalog has no resolvable /Pages tree");
  } else {
    errors.push("no /Root catalog found");
  }

  // Collect page content streams.
  const seenContents = new Set<string>();
  const collectContents = (node: PdfObject, refKey: string): string[] => {
    if (seenContents.has(refKey)) return [];
    seenContents.add(refKey);
    const type = dictValue(node.dict, "Type");
    if (type === "/Page") {
      const contents = /\/Contents\s*(?:(\d+\s+\d+\s+R)|\[([\d\s+R]*)\])/.exec(node.dict);
      const texts: string[] = [];
      if (contents) {
        const refs = (contents[1] ? [contents[1]] : contents[2]?.match(/\d+\s+\d+\s+R/g) ?? []);
        for (const ref of refs) {
          const obj = deref(ref);
          if (!obj) continue;
          if (obj.stream !== null) {
            const filters = dictValue(obj.dict, "Filter") ?? "";
            texts.push(filters.includes("FlateDecode") ? inflate(obj.stream) : obj.stream);
          } else {
            texts.push(obj.dict);
          }
        }
      }
      // Follow Form XObjects reachable via /Resources -> /XObject.
      const resRef = dictRef(node.dict, "Resources");
      const res = deref(resRef);
      if (res) {
        const xobjValue = dictValue(res.dict, "XObject");
        if (xobjValue && /<<[\s\S]*>>/.test(xobjValue)) {
          const inner = /<<([\s\S]*?)>>/.exec(xobjValue)?.[1] ?? "";
          const innerRefs = inner.match(/\d+\s+\d+\s+R/g) ?? [];
          for (const ref of innerRefs) {
            const obj = deref(ref);
            if (!obj || obj.stream === null) continue;
            if (!/\/Subtype\s*\/Form/.test(obj.dict)) continue;
            const filters = dictValue(obj.dict, "Filter") ?? "";
            texts.push(filters.includes("FlateDecode") ? inflate(obj.stream) : obj.stream);
          }
        }
      }
      return texts;
    }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(node.dict);
    if (!kids) return [];
    const refs = kids[1].match(/\d+\s+\d+\s+R/g) ?? [];
    const texts: string[] = [];
    for (const ref of refs) {
      const child = deref(ref);
      if (child) texts.push(...collectContents(child, ref.trim()));
    }
    return texts;
  };

  let text = "";
  if (root) {
    const pagesRef = dictRef(root.dict, "Pages");
    const pages = deref(pagesRef);
    if (pages) text = collectContents(pages, (pagesRef ?? "").trim()).map(extractTextFromContent).filter((t) => t !== "").join("\n");
  }

  const extractionAvailable = text.trim() !== "" || pageCount !== null;
  return { pageCount, info, text: text.trim(), extractionAvailable, errors, warnings };
}
