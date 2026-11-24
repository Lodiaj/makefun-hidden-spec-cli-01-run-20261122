// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool calls), applies it to the tree in the working directory, and
// changes every file or none. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// With MAKEFUN_ENV_URL set, this file hands a trial over to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A hard stop: the run ends with exit 2 and this one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: reported, the edit rolled back, the rest still run. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const edgeWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file as lines: its own break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitText(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** One line of the new side: text, plus the old-side index when it is a context line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Two lines equal at a tier: 0 exact, 1 trailing space/tab ignored, 2 both edges ignored. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return edgeWs(a) === edgeWs(b);
}

/** Every position at or after `from` where oldLines matches the file's lines at this tier. */
function occurrencesAt(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  if (k === 0) return out;
  for (let i = from; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which oldLines occurs at least once. */
function findTier(lines: string[], oldLines: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrencesAt(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The new side's lines as written: context lines as the file's own matched lines, the rest re-indented at tier 2. */
function buildNew(fileLines: string[], oldLines: string[], news: NewLine[], pos: number, tier: number): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(oldLines[0] ?? '');
  return news.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx]!;
    const t = n.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** Replace delCount lines at pos with ins, overriding the final break only when asked. */
function spliceDoc(doc: FileDoc, pos: number, delCount: number, ins: string[], finalOverride: boolean | null): FileDoc {
  const lines = [...doc.lines];
  lines.splice(pos, delCount, ...ins);
  return { lines, br: doc.br, final: finalOverride === null ? doc.final : finalOverride };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, so the report can print R lines for them. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const load = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = load(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const fold = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = fold(before);
      const old = fold(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + fold(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = load(tree);
      const doc = splitText(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const next = spliceDoc(doc, line, 0, add, null);
      tree.now.set(p, joinText(next));
    };
  }
  return null;
}

/** The JSON edits of a patch: one array, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a hunk or chunk: context, old, new, or a backslash marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

/** A header path: after the four characters, up to the first tab, trimmed, one a/ or b/ removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The sections of a unified diff, in order. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let pairSeen = false;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let diffOld = '';
  let diffNew = '';

  const finishSection = (): void => {
    if (cur === null) return;
    cur.oldPath = pairOld ?? renameOld ?? diffOld;
    cur.newPath = pairNew ?? renameNew ?? diffNew;
    sections.push(cur);
    cur = null;
  };
  const freshSection = (): Section => ({ oldPath: '', newPath: '', newFile: false, deleted: false, hunks: [] });

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      cur = freshSection();
      diffOld = m[1]!;
      diffNew = m[2]!;
      inHeader = true;
      pairSeen = false;
      pairOld = null;
      pairNew = null;
      renameOld = null;
      renameNew = null;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !pairSeen) {
        pairOld = headerPath(line);
        pairNew = headerPath(lines[i + 1]!);
        pairSeen = true;
        i += 2;
        continue;
      }
      finishSection();
      cur = freshSection();
      diffOld = '';
      diffNew = '';
      pairOld = headerPath(line);
      pairNew = headerPath(lines[i + 1]!);
      pairSeen = true;
      inHeader = true;
      renameOld = null;
      renameNew = null;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < n) {
        const l = lines[j]!;
        if (l === '') {
          body.push({ kind: ' ', text: '' });
          j++;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
          body.push({ kind: c as BodyLine['kind'], text: l.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const lastB = body[body.length - 1]!;
        if (lastB.kind === ' ' && lastB.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: Number(hm[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        pairNew = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deleted = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  finishSection();
  return sections;
}

/** A hunk's old lines and new lines, context lines marked with their old-side index. */
function hunkLines(h: Hunk): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      oldLines.push(b.text);
      newLines.push({ text: b.text, ctx: oldLines.length - 1 });
    } else if (b.kind === '-') {
      oldLines.push(b.text);
    } else if (b.kind === '+') {
      newLines.push({ text: b.text, ctx: null });
    }
  }
  return { oldLines, newLines };
}

/** Whether a backslash line follows the hunk's last context or + line. */
function backslashAfterLast(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      return h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** A section's hunks, in order, each on the result of the ones before it. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newLines } = hunkLines(h);
    if (oldLines.length === 0) {
      if (newLines.length === 0) continue;
      const at = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const made = newLines.map((x) => x.text);
      const endFinal = at === cur.lines.length ? !backslashAfterLast(h) : null;
      cur = spliceDoc(cur, at, 0, made, endFinal);
      d += newLines.length;
      continue;
    }
    const found = findTier(cur.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        pos = p;
        best = dist;
      }
    }
    const made = buildNew(cur.lines, oldLines, newLines, pos, found.tier);
    const reachesEnd = pos + oldLines.length === cur.lines.length;
    cur = spliceDoc(cur, pos, oldLines.length, made, reachesEnd ? !backslashAfterLast(h) : null);
    d += newLines.length - oldLines.length;
  }
  return cur;
}

/** One unified section as one edit: create, delete, move, or change. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.newFile || oldP === '/dev/null';
    const isDelete = !isCreate && (sec.deleted || newP === '/dev/null');
    const isMove = !isCreate && !isDelete && oldP !== newP;
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastNoBreak = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.kind === '+') {
            plus.push(b.text);
            lastNoBreak = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastNoBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = applyHunks(splitText(cur), sec.hunks, strict, oldP);
      tree.now.set(newP, joinText(doc));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const doc = applyHunks(splitText(cur), sec.hunks, strict, oldP);
    tree.now.set(oldP, joinText(doc));
  };
}

/** One SEARCH/REPLACE block as one edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = splitText(cur);
    const found = findTier(doc.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const made = buildNew(
      doc.lines,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: null })),
      pos,
      found.tier,
    );
    tree.now.set(path, joinText(spliceDoc(doc, pos, oldLines.length, made, null)));
  };
}

/** The SEARCH/REPLACE blocks of a patch, in order. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  for (;;) {
    let sIdx = -1;
    for (let k = searchFrom; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = k;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    edits.push(srEdit(path, lines.slice(sIdx + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    searchFrom = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One chunk of a V4A Update section: an optional anchor, body lines, and whether it is end-of-file. */
interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** A chunk's old lines and new lines, context lines marked with their old-side index. */
function chunkLines(ch: Chunk): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of ch.body) {
    if (b.kind === ' ') {
      oldLines.push(b.text);
      newLines.push({ text: b.text, ctx: oldLines.length - 1 });
    } else if (b.kind === '-') {
      oldLines.push(b.text);
    } else if (b.kind === '+') {
      newLines.push({ text: b.text, ctx: null });
    }
  }
  return { oldLines, newLines };
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** One V4A Add File section as one edit. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section as one edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as one edit, chunks in order with a moving cursor. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = splitText(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(doc.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { oldLines, newLines } = chunkLines(ch);
      if (oldLines.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const made = newLines.map((x) => x.text);
        doc = spliceDoc(doc, at, 0, made, null);
        cursor = at + made.length;
        continue;
      }
      const found = findTier(doc.lines, oldLines, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let pos: number;
      if (ch.eof) {
        const ends = found.occ.filter((p) => p + oldLines.length === doc.lines.length);
        if (ends.length === 0) throw new Fail('no-match', path);
        pos = ends[0]!;
      } else {
        pos = found.occ[0]!;
      }
      const made = buildNew(doc.lines, oldLines, newLines, pos, found.tier);
      doc = spliceDoc(doc, pos, oldLines.length, made, null);
      cursor = pos + made.length;
    }
    const text = joinText(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
      return;
    }
    tree.now.set(path, text);
  };
}

/** Whether a line starts a V4A section. */
function v4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

/** The V4A sections of a patch, in order. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const collected: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) collected.push(l.slice(1));
        else if (l.trim() === '') collected.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      edits.push(v4aAddEdit(path, collected));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      if (j < last) {
        const l = lines[j]!;
        if (!v4aSectionStart(l) && l.trim() !== '*** End Patch') throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let pendingBlanks: BodyLine[] = [];
      const flush = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      const attachBlanks = (): void => {
        if (cur !== null) {
          for (const b of pendingBlanks) cur.body.push(b);
        }
        pendingBlanks = [];
      };
      while (j < last) {
        const l = lines[j]!;
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.trim() === '') {
          pendingBlanks.push({ kind: ' ', text: l.slice(1) });
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          attachBlanks();
          flush();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          j++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          attachBlanks();
          cur.eof = true;
          flush();
          j++;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          attachBlanks();
          cur.body.push({ kind: l[0] as BodyLine['kind'], text: l.slice(1) });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** The patch's format with --format=auto: the first rule that holds, else null. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteLess)) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now !== null && now !== tree.original(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
