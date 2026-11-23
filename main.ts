// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies AI-written edits in four
// formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a
// tree of text files, to the specification in SPEC.md. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4 (command line, output and exit codes, safe paths, format detection), 9 (JSON edits) and 10
// (order and atomicity) are the kit's starter; sections 5 (three-tier line matching), 6 (unified diffs),
// 7 (SEARCH/REPLACE blocks) and 8 (V4A patches) are implemented here, as is the `R old -> new` output line
// for a move edit. In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Move edits record their pair here so the output can print `R old -> new` for them. */
const movePairs: Array<[string, string]> = [];

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// Section 5: matching lines, and the file's own lines, break and final break.
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const ta = a.replace(/[ \t]+$/, '');
  const tb = b.replace(/[ \t]+$/, '');
  if (tier === 1) return ta === tb;
  return ta.replace(/^[ \t]+/, '') === tb.replace(/^[ \t]+/, '');
}

/** Every 0-based start position where O occurs in lines at the given tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NItem {
  text: string;
  ctx: number | null;
}

/** N with context lines taken from the file and, at tier 2, the other lines re-indented. */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NItem[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[at] ?? '');
    p = leadingWs(o[0] ?? '');
  }
  for (const item of n) {
    if (item.ctx !== null) {
      out.push(fileLines[at + item.ctx]!);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/** Split a hunk/chunk body into its old lines O and its new lines N (with context marks). */
function splitON(body: BodyLine[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The text after `--- ` / `+++ `, up to the first tab, with surrounding spaces removed. */
function pathField(s: string): string {
  return s.split('\t')[0]!.trim();
}

/** A `---` / `+++` path: `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function dashPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** A hunk body: lines after the header starting with ` `, `-`, `+`, `\` or empty. */
function parseHunkBody(lines: string[], i: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c, text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === ' ' && last.text === '') body.pop();
    else break;
  }
  return { body, next: j };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function lastCtxPlusBackslash(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') return body[k + 1]?.kind === '\\';
  }
  return false;
}

/** True when a `\` line follows the section's last `+` line (for a created file). */
function creationBackslash(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === '+') return body[k + 1]?.kind === '\\';
    }
  }
  return false;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Raw {
    diffOld: string | null;
    diffNew: string | null;
    dashOld: string | null;
    dashNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
    hasPair: boolean;
    headerDone: boolean;
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  let i = 0;
  const startSection = (): Raw => {
    const s: Raw = {
      diffOld: null,
      diffNew: null,
      dashOld: null,
      dashNew: null,
      renameFrom: null,
      renameTo: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
      hasPair: false,
      headerDone: false,
    };
    raws.push(s);
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || l === 'diff --git') {
      const m = DIFF_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.headerDone && !cur.hasPair) {
        cur.dashOld = pathField(l.slice(4));
        cur.dashNew = pathField(lines[i + 1]!.slice(4));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = startSection();
      cur.dashOld = pathField(l.slice(4));
      cur.dashNew = pathField(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.headerDone = true;
        const { body, next } = parseHunkBody(lines, i + 1);
        cur.hunks.push({ a: parseInt(m[1]!, 10), body });
        i = next;
        continue;
      }
      i++;
      continue;
    }
    if (cur !== null && cur.headerDone) {
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const { body, next } = parseHunkBody(lines, i + 1);
        cur.hunks.push({ a: parseInt(m[1]!, 10), body });
        i = next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return raws.map((r) => {
    const oldPath = r.dashOld !== null ? dashPath(r.dashOld) : r.renameFrom ?? r.diffOld;
    const newPath = r.dashNew !== null ? dashPath(r.dashNew) : r.renameTo ?? r.diffNew;
    const sec: Section = {
      oldPath,
      newPath,
      isCreate: r.isCreate || oldPath === null,
      isDelete: r.isDelete || newPath === null,
      hunks: r.hunks,
    };
    return unifiedSectionEdit(sec, strict);
  });
}

/** Apply one hunk to the file state; returns the new line-offset d. */
function applyHunk(st: FileState, hunk: Hunk, strict: boolean, path: string, d: number): number {
  const { o, n } = splitON(hunk.body);
  if (o.length > 0) {
    const found = findTier(st.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const at = best;
    const rep = buildReplacement(st.lines, at, o, n, found.tier);
    const touchesEnd = at + o.length === st.lines.length;
    st.lines.splice(at, o.length, ...rep);
    if (touchesEnd) st.finalBreak = !lastCtxPlusBackslash(hunk.body);
    return d + (n.length - o.length);
  }
  const idx = Math.max(0, Math.min(hunk.a + d, st.lines.length));
  const rep = n.map((x) => x.text);
  const atEnd = idx === st.lines.length;
  st.lines.splice(idx, 0, ...rep);
  if (atEnd) st.finalBreak = !lastCtxPlusBackslash(hunk.body);
  return d + n.length;
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const paths: string[] = [];
    if (sec.oldPath !== null) paths.push(sec.oldPath);
    if (sec.newPath !== null) paths.push(sec.newPath);
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    if (sec.isCreate) {
      const np = sec.newPath;
      if (np === null) throw new Fail('missing', sec.oldPath ?? '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (creationBackslash(sec.hunks) ? '' : '\n'));
      return;
    }
    if (sec.isDelete) {
      const op = sec.oldPath;
      if (op === null) throw new Fail('missing', sec.newPath ?? '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath) {
      const op = sec.oldPath;
      const np = sec.newPath;
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const st = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) d = applyHunk(st, h, strict, op, d);
      tree.now.set(op, null);
      tree.now.set(np, joinFile(st));
      movePairs.push([op, np]);
      return;
    }
    const p = (sec.oldPath ?? sec.newPath)!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const st = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) d = applyHunk(st, h, strict, p, d);
    tree.now.set(p, joinFile(st));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let i = 0;
  let blockStart = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = searchLine - 1; j >= blockStart; j--) {
        const lj = lines[j]!;
        if (blank(lj)) continue;
        if (lj.trim().startsWith('```')) continue;
        path = lj.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      let sep = -1;
      let k = searchLine + 1;
      for (; k < lines.length; k++) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') {
          sep = k;
          break;
        }
        if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine + 1}`);
      }
      if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let end = -1;
      for (k = sep + 1; k < lines.length; k++) {
        const t = lines[k]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
        if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine + 1}`);
      }
      if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, oldLines: lines.slice(searchLine + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevPath = path;
      blockStart = end + 1;
      i = end + 1;
      continue;
    }
    i++;
  }
  return blocks.map((b) => {
    return (tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const st = splitFile(cur);
      const found = findTier(st.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const at = found.occ[0]!;
      const rep = buildReplacement(
        st.lines,
        at,
        b.oldLines,
        b.newLines.map((t) => ({ text: t, ctx: null })),
        found.tier,
      );
      st.lines.splice(at, b.oldLines.length, ...rep);
      tree.now.set(b.path, joinFile(st));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
  fromBlank: boolean[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
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
  const isSectionStart = (s: string): boolean =>
    s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const content: string[] = [];
      const fromBlank: boolean[] = [];
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m.startsWith('+')) {
          content.push(m.slice(1));
          fromBlank.push(false);
          i++;
          continue;
        }
        if (blank(m)) {
          content.push('');
          fromBlank.push(true);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (content.length > 0 && fromBlank[fromBlank.length - 1]) {
        content.pop();
        fromBlank.pop();
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (blank(m)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let chunkStarted = false;
      const finishChunk = (trimBlanks: boolean): void => {
        if (cur === null) return;
        if (trimBlanks) {
          while (cur.body.length > 0 && cur.fromBlank[cur.fromBlank.length - 1]) {
            cur.body.pop();
            cur.fromBlank.pop();
          }
        }
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m.trim() === '*** End of File' && m[0] !== ' ') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          finishChunk(false);
          i++;
          continue;
        }
        if (m.startsWith('@@')) {
          finishChunk(false);
          const anchorText = m.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [], fromBlank: [] };
          chunkStarted = true;
          i++;
          continue;
        }
        if (blank(m) && cur === null && chunkStarted) {
          // A blank line after a finished chunk, at the end of the section: not part of it.
          i++;
          continue;
        }
        if (m === '' || m[0] === ' ' || m[0] === '-' || m[0] === '+') {
          if (cur === null) {
            if (chunkStarted) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [], fromBlank: [] };
            chunkStarted = true;
          }
          if (m === '') {
            cur.body.push({ kind: ' ', text: '' });
            cur.fromBlank.push(true);
          } else {
            cur.body.push({ kind: m[0] as ' ' | '-' | '+', text: m.slice(1) });
            cur.fromBlank.push(blank(m));
          }
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      finishChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(cur);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      const { o, n } = splitON(ch.body);
      if (ch.anchor !== null) {
        let found: { i: number } | null = null;
        for (const t of tiers) {
          for (let k = cursor; k < st.lines.length; k++) {
            if (tierEq(st.lines[k]!, ch.anchor, t)) {
              found = { i: k };
              break;
            }
          }
          if (found !== null) break;
        }
        if (found === null) throw new Fail('no-match', path);
        cursor = found.i + 1;
      }
      if (o.length > 0) {
        let hit: { tier: number; at: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(st.lines, o, t).filter((p) => p >= cursor && (!ch.eof || p + o.length === st.lines.length));
          if (occ.length > 0) {
            hit = { tier: t, at: occ[0]! };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', path);
        const rep = buildReplacement(st.lines, hit.at, o, n, hit.tier);
        st.lines.splice(hit.at, o.length, ...rep);
        cursor = hit.at + rep.length;
      } else {
        const idx = ch.eof ? st.lines.length : cursor;
        const rep = n.map((x) => x.text);
        st.lines.splice(idx, 0, ...rep);
        cursor = idx + rep.length;
      }
    }
    const out = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      movePairs.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  movePairs.length = 0;
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = movePairs.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      movePairs.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of movePairs) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
