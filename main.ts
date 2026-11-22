// mend: one patch tool for every AI edit format.
//
// Applies an edit a model wrote to a tree of text files, in one of four
// formats: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits.
// Every line the patch names is found at the first of three matching tiers
// (exact, trailing whitespace ignored, both ends ignored), and either every
// edit lands or nothing is written at all.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// PATCH is read from standard input when it is absent or `-`.
// Node 22, the standard library alone.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: exactly one line on standard output. */
class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed; the run reports it and writes nothing. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it names a file under the working directory. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailingWs = (s: string): string => {
  const m = /[ \t]*$/.exec(s);
  return m === null ? '' : m[0];
};

/** One file as lines plus its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  ends: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const firstNl = text.indexOf('\n');
  const br: '\r\n' | '\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const lines = text.split(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function writeState(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.ends ? s.br : '');
}

/** Two lines equal at one matching tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.slice(0, a.length - trailingWs(a).length) === b.slice(0, b.length - trailingWs(b).length);
  return a.trim() === b.trim();
}

/** Positions where old occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which old occurs in lines, or -1 when it occurs at none. */
function findTier(lines: string[], old: string[], strict: boolean): number {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier += 1) {
    if (occurrences(lines, old, tier).length > 0) return tier;
  }
  return -1;
}

/**
 * One replacement. `slots` are the new lines in order; a slot marked ctx is a
 * context line, written as the file's own matched line, and a slot marked new
 * is a fresh line, re-indented at tier 2. `oMap` names, for each context slot,
 * its index in the old lines. Returns the replacement lines.
 */
function buildReplacement(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  slots: { kind: 'ctx' | 'new'; text: string }[],
  oMap: number[],
  tier: number,
): string[] {
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oldLines[0] ?? '');
  const out: string[] = [];
  let ctxSeen = 0;
  for (const slot of slots) {
    if (slot.kind === 'ctx') {
      out.push(fileLines[pos + oMap[ctxSeen]!]!);
      ctxSeen += 1;
      continue;
    }
    let line = slot.text;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) {
      line = f + line.slice(p.length);
    }
    out.push(line);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now`, the rest from disk. */
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

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

/** One edit of a patch: apply it to the tree, or throw EditFail. */
interface Edit {
  run: (tree: Tree) => void;
  /** A move this edit performs, for the R line of the output. */
  move?: [string, string];
}

/** Read a file the edit needs, or fail with missing. */
function needFile(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new EditFail('missing', p);
  return t;
}

/** Guard a path before anything else is said about it. */
function needSafe(p: string): void {
  if (!safePath(p)) throw new EditFail('unsafe', p);
}

/** Replace old lines in a file's state at one position, keeping its own break. */
function spliceLines(
  st: FileState,
  pos: number,
  oldLen: number,
  replacement: string[],
  ends: boolean,
): FileState {
  const lines = [...st.lines.slice(0, pos), ...replacement, ...st.lines.slice(pos + oldLen)];
  return { lines, br: st.br, ends };
}

/* ------------------------------------------------------------------ */
/* Unified diffs                                                       */
/* ------------------------------------------------------------------ */

/** One body line of a hunk: context, old, new, or a backslash marker. */
interface HunkSlot {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this slot at once. */
  backslash: boolean;
}

interface Hunk {
  /** The hunk's old start line, 1-based. */
  a: number;
  slots: HunkSlot[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
  /** The last `+` line of the section has a `\` line after it. */
  lastPlusBackslash: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A hunk's old lines (context and `-`) and new lines (context and `+`). */
function hunkSides(hunk: Hunk): { oldLines: string[]; newSlots: HunkSlot[]; newMap: number[] } {
  const oldLines: string[] = [];
  const newSlots: HunkSlot[] = [];
  const newMap: number[] = [];
  let oIdx = 0;
  for (const slot of hunk.slots) {
    if (slot.kind === 'ctx') {
      oldLines.push(slot.text);
      newSlots.push(slot);
      newMap.push(oIdx);
      oIdx += 1;
    } else if (slot.kind === 'old') {
      oldLines.push(slot.text);
      oIdx += 1;
    } else {
      newSlots.push(slot);
    }
  }
  return { oldLines, newSlots, newMap };
}

/** Apply one section's hunks to a file's state, in order. */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = st;
  let d = 0;
  for (const hunk of hunks) {
    const { oldLines, newSlots, newMap } = hunkSides(hunk);
    const lastCtxOrNew = [...hunk.slots].reverse().find((s) => s.kind === 'ctx' || s.kind === 'new');
    const tailNoBreak = lastCtxOrNew !== undefined && lastCtxOrNew.backslash;
    if (oldLines.length > 0) {
      const tier = findTier(cur.lines, oldLines, strict);
      if (tier < 0) throw new EditFail('no-match', path);
      const occ = occurrences(cur.lines, oldLines, tier);
      const target = hunk.a - 1 + d;
      let pos = occ[0]!;
      let best = Math.abs(pos - target);
      for (const o of occ) {
        const dist = Math.abs(o - target);
        if (dist < best) {
          best = dist;
          pos = o;
        }
      }
      const replacement = buildReplacement(cur.lines, pos, oldLines, newSlots, newMap, tier);
      const touchesEnd = pos + oldLines.length === cur.lines.length;
      cur = spliceLines(cur, pos, oldLines.length, replacement, touchesEnd ? !tailNoBreak : cur.ends);
      d += newSlots.length - oldLines.length;
    } else {
      const insertAt = Math.max(0, Math.min(hunk.a + d, cur.lines.length));
      const replacement = newSlots.map((s) => s.text);
      const touchesEnd = insertAt === cur.lines.length;
      cur = spliceLines(cur, insertAt, 0, replacement, touchesEnd ? !tailNoBreak : cur.ends);
      d += newSlots.length;
    }
  }
  return cur;
}

/** Read the unified diff's sections and hunks; each section is one edit. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let pairSeen = false;
  let inHeader = false;

  const startSection = (gitOld: string | null, gitNew: string | null): void => {
    cur = { oldPath: gitOld, newPath: gitNew, creation: false, deletion: false, hunks: [], lastPlusBackslash: false };
    pairSeen = false;
    inHeader = true;
    sections.push(cur);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (cur === null || !inHeader)) {
      // A `--- ` line followed by `+++ ` starts a section, unless it is
      // already part of the current section's header.
      startSection(null, null);
      // The pair is read as this section's header below.
    } else if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), slots: [] };
      i += 1;
      // The body: lines starting with space, `-`, `+`, `\`, or empty; it ends
      // at a `diff --git` line, at a `--- ` line followed by `+++ `, or at the
      // first other line. Empty lines at its end are not part of it.
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let lastSlot: HunkSlot | null = null;
      for (const b of body) {
        if (b.startsWith('\\')) {
          if (lastSlot !== null) lastSlot.backslash = true;
          continue;
        }
        const slot: HunkSlot =
          b === '' ? { kind: 'ctx', text: '', backslash: false }
          : b.startsWith(' ') ? { kind: 'ctx', text: b.slice(1), backslash: false }
          : b.startsWith('-') ? { kind: 'old', text: b.slice(1), backslash: false }
          : { kind: 'new', text: b.slice(1), backslash: false };
        hunk.slots.push(slot);
        lastSlot = slot;
      }
      cur.hunks.push(hunk);
      const lastPlus = [...hunk.slots].reverse().find((s) => s.kind === 'new');
      if (lastPlus !== undefined) cur.lastPlusBackslash = lastPlus.backslash;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const take = (s: string): string => {
          const cut = s.indexOf('\t');
          return (cut < 0 ? s : s.slice(0, cut)).trim();
        };
        const oldRaw = take(line.slice(4));
        const newRaw = take(lines[i + 1]!.slice(4));
        const strip = (p: string): string | null => {
          if (p === '/dev/null') return null;
          if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
          return p;
        };
        cur.oldPath = strip(oldRaw);
        cur.newPath = strip(newRaw);
        pairSeen = true;
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!pairSeen) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!pairSeen) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.creation = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletion = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (s.creation || oldP === null) {
      if (newP === null) continue;
      const plus: string[] = [];
      for (const h of s.hunks) for (const slot of h.slots) if (slot.kind === 'new') plus.push(slot.text);
      edits.push({
        run: (tree) => {
          needSafe(newP);
          if (tree.get(newP) !== null) throw new EditFail('exists', newP);
          tree.set(newP, plus.length === 0 ? '' : plus.join('\n') + (s.lastPlusBackslash ? '' : '\n'));
        },
      });
      continue;
    }
    if (s.deletion || newP === null) {
      if (oldP === null) continue;
      edits.push({
        run: (tree) => {
          needSafe(oldP);
          needFile(tree, oldP);
          tree.set(oldP, null);
        },
      });
      continue;
    }
    if (oldP !== newP) {
      edits.push({
        move: [oldP, newP],
        run: (tree) => {
          needSafe(oldP);
          needSafe(newP);
          const text = needFile(tree, oldP);
          if (tree.get(newP) !== null) throw new EditFail('exists', newP);
          const done = applyHunks(readState(text), s.hunks, strict, oldP);
          tree.set(newP, writeState(done));
          tree.set(oldP, null);
        },
      });
      continue;
    }
    edits.push({
      run: (tree) => {
        needSafe(oldP);
        const text = needFile(tree, oldP);
        const done = applyHunks(readState(text), s.hunks, strict, oldP);
        tree.set(oldP, writeState(done));
      },
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks                                               */
/* ------------------------------------------------------------------ */

/** Read the SEARCH/REPLACE blocks; each block is one edit. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    // The path: the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevReplace; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    // The old lines run to `=======`, the new lines to `>>>>>>> REPLACE`.
    let sep = -1;
    let j = searchAt + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (l.trimEnd() === '>>>>>>> REPLACE' || l.trimEnd() === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let end = -1;
    j = sep + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    if (oldLines.length === 0) {
      edits.push({
        run: (tree) => {
          needSafe(p);
          if (tree.get(p) !== null) throw new EditFail('exists', p);
          tree.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        },
      });
    } else {
      edits.push({
        run: (tree) => {
          needSafe(p);
          const text = needFile(tree, p);
          const st = readState(text);
          const tier = findTier(st.lines, oldLines, strict);
          if (tier < 0) throw new EditFail('no-match', p);
          const occ = occurrences(st.lines, oldLines, tier);
          if (occ.length > 1) throw new EditFail('ambiguous', p);
          const pos = occ[0]!;
          const slots = newLines.map((t) => ({ kind: 'new' as const, text: t }));
          const replacement = buildReplacement(st.lines, pos, oldLines, slots, [], tier);
          tree.set(p, writeState(spliceLines(st, pos, oldLines.length, replacement, st.ends)));
        },
      });
    }
    prevReplace = end;
    prevPath = p;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches                                                         */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  slots: HunkSlot[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** For add sections: the file's lines, `+` removed. */
  addLines: string[];
  chunks: V4aChunk[];
  /** Line number of the section's header, for parse errors. */
  headerLine: number;
}

/** Apply one V4A chunk to a file's state, moving the cursor as it goes. */
function applyV4aChunk(st: FileState, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  let cur = st;
  let at = cursor;
  if (chunk.anchor !== null) {
    const anchor = chunk.anchor;
    let found = -1;
    for (let tier = 0; tier < (strict ? 1 : 3); tier += 1) {
      for (let k = at; k < cur.lines.length; k += 1) {
        if (lineEq(cur.lines[k]!, anchor, tier)) {
          found = k;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) throw new EditFail('no-match', path);
    at = found + 1;
  }
  const { oldLines, newSlots, newMap } = hunkSides({ a: 0, slots: chunk.slots });
  if (oldLines.length === 0) {
    const insertAt = chunk.eof ? cur.lines.length : at;
    const replacement = newSlots.map((s) => s.text);
    cur = spliceLines(cur, insertAt, 0, replacement, cur.ends);
    return { state: cur, cursor: insertAt + replacement.length };
  }
  const tier = findTierFrom(cur.lines, oldLines, at, strict);
  if (tier < 0) throw new EditFail('no-match', path);
  const occ = occurrencesFrom(cur.lines, oldLines, at, tier);
  if (occ.length === 0) throw new EditFail('no-match', path);
  let pos = occ[0]!;
  if (chunk.eof) {
    const ending = occ.find((o) => o + oldLines.length === cur.lines.length);
    if (ending === undefined) throw new EditFail('no-match', path);
    pos = ending;
  }
  const replacement = buildReplacement(cur.lines, pos, oldLines, newSlots, newMap, tier);
  cur = spliceLines(cur, pos, oldLines.length, replacement, cur.ends);
  return { state: cur, cursor: pos + replacement.length };
}

/** The first tier at which old occurs at or after `from`, or -1. */
function findTierFrom(lines: string[], old: string[], from: number, strict: boolean): number {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier += 1) {
    if (occurrencesFrom(lines, old, from, tier).length > 0) return tier;
  }
  return -1;
}

/** Occurrences of old at or after `from`, at one tier. */
function occurrencesFrom(lines: string[], old: string[], from: number, tier: number): number[] {
  return occurrences(lines, old, tier).filter((o) => o >= from);
}

/** Read the V4A sections; each section is one edit. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const section: V4aSection = { kind, path, moveTo: null, addLines: [], chunks: [], headerLine: i + 1 };
    sections.push(section);
    i += 1;
    // The section's lines run to the next section, `*** End Patch`, or the end.
    const raw: string[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch') break;
      raw.push(l);
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      for (let r = 0; r < raw.length; r += 1) {
        const l = raw[r]!;
        if (l === '') section.addLines.push('');
        else if (l.startsWith('+')) section.addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i - raw.length + r + 1}`);
      }
    } else if (kind === 'delete') {
      for (let r = 0; r < raw.length; r += 1) {
        if (!isBlank(raw[r]!)) throw new Exit2(`error: parse ${i - raw.length + r + 1}`);
      }
    } else {
      let chunk: V4aChunk | null = null;
      let seenMove = false;
      let seenBody = false;
      let startedAny = false;
      const startChunk = (anchor: string | null): void => {
        chunk = { anchor, eof: false, slots: [] };
        section.chunks.push(chunk);
        startedAny = true;
      };
      for (let r = 0; r < raw.length; r += 1) {
        const l = raw[r]!;
        if (!seenBody && !seenMove && l.startsWith('*** Move to: ')) {
          section.moveTo = l.slice('*** Move to: '.length).trim();
          seenMove = true;
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i - raw.length + r + 1}`);
        if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i - raw.length + r + 1}`);
          chunk.eof = true;
          chunk = null;
          seenBody = true;
          continue;
        }
        if (l.startsWith('@@')) {
          startChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim());
          seenBody = true;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            // Only the first chunk may start at a body line.
            if (startedAny) throw new Exit2(`error: parse ${i - raw.length + r + 1}`);
            startChunk(null);
            seenBody = true;
          }
          const slot: HunkSlot =
            l === '' ? { kind: 'ctx', text: '', backslash: false }
            : l.startsWith(' ') ? { kind: 'ctx', text: l.slice(1), backslash: false }
            : l.startsWith('-') ? { kind: 'old', text: l.slice(1), backslash: false }
            : { kind: 'new', text: l.slice(1), backslash: false };
          chunk!.slots.push(slot);
          continue;
        }
        throw new Exit2(`error: parse ${i - raw.length + r + 1}`);
      }
      if (section.chunks.length === 0 && section.moveTo === null) {
        throw new Exit2(`error: parse ${section.headerLine}`);
      }
    }
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const content = s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n';
      edits.push({
        run: (tree) => {
          needSafe(p);
          if (tree.get(p) !== null) throw new EditFail('exists', p);
          tree.set(p, content);
        },
      });
      continue;
    }
    if (s.kind === 'delete') {
      const p = s.path;
      edits.push({
        run: (tree) => {
          needSafe(p);
          needFile(tree, p);
          tree.set(p, null);
        },
      });
      continue;
    }
    const p = s.path;
    const to = s.moveTo;
    const edit: Edit = {
      run: (tree) => {
        needSafe(p);
        if (to !== null) needSafe(to);
        const text = needFile(tree, p);
        if (to !== null && tree.get(to) !== null) throw new EditFail('exists', to);
        let cur = readState(text);
        let cursor = 0;
        for (const chunk of s.chunks) {
          const done = applyV4aChunk(cur, chunk, cursor, strict, p);
          cur = done.state;
          cursor = done.cursor;
        }
        const out = writeState(cur);
        if (to !== null) {
          tree.set(to, out);
          tree.set(p, null);
        } else {
          tree.set(p, out);
        }
      },
    };
    if (to !== null) edit.move = [p, to];
    edits.push(edit);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits                                                          */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return {
      run: (tree) => {
        needSafe(p);
        if (tree.get(p) !== null) throw new EditFail('exists', p);
        tree.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      run: (tree) => {
        needSafe(p);
        const before = needFile(tree, p);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = lf(before);
        const old = lf(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new EditFail('no-match', p);
        if (count > 1) throw new EditFail('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
        tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      run: (tree) => {
        needSafe(p);
        const before = needFile(tree, p);
        const st = readState(before);
        if (line < 0 || line > st.lines.length) throw new EditFail('no-match', p);
        tree.set(p, writeState(spliceLines(st, line, 0, add, st.ends)));
      },
    };
  }
  return null;
}

/** Read the JSON edits; each edit object is one edit. */
function parseJson(text: string): Edit[] {
  const lines = patchLines(text);
  const first = lines.findIndex((l) => !isBlank(l));
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
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k]!;
    if (isBlank(l)) continue;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${k + 1}`);
    edits.push(e);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection, CLI, and the run                                  */
/* ------------------------------------------------------------------ */

/** The patch's format, or null when no format's markers are in it. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

interface RunResult {
  code: number;
  out: string[];
}

function usage(): RunResult {
  return { code: 2, out: ['error: usage'] };
}

function noPatch(): RunResult {
  return { code: 2, out: ['error: no-patch'] };
}

/** The whole run: parse the arguments, apply the patch, report. */
function run(argv: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let ended = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!ended && arg === '--') {
      ended = true;
    } else if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && FORMATS.includes(arg.slice('--format='.length))) {
        format = arg.slice('--format='.length);
      } else if (arg === '--check' && !check) {
        check = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return usage();
      }
    } else {
      if (patch !== null) return usage();
      patch = arg;
    }
  }

  let text: string;
  if (patch === null || patch === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patch, 'utf8');
    } catch {
      return noPatch();
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.run(tree);
    } catch (e) {
      if (e instanceof EditFail) {
        tree.now.clear();
        for (const [k, v] of before) tree.now.set(k, v);
        fails.push(e);
        continue;
      }
      throw e;
    }
  }
  if (fails.length > 0) {
    const out = fails.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${fails.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  // What changed, against the tree as it was before.
  const rows: string[] = [];
  const changed = new Set<string>();
  for (const [p, v] of tree.now) {
    const before = tree.original(p);
    if (before === v) continue;
    changed.add(p);
    if (v === null) rows.push(`D ${p}`);
    else if (before === null) rows.push(`A ${p}`);
    else rows.push(`M ${p}`);
  }
  const moves = new Map<string, string>();
  for (const edit of edits) {
    if (edit.move !== undefined) moves.set(edit.move[0], edit.move[1]);
  }
  for (const [oldP, newP] of moves) {
    if (!changed.has(oldP) && !changed.has(newP)) continue;
    const i = rows.findIndex((r) => r === `D ${oldP}`);
    const j = rows.findIndex((r) => r === `A ${newP}`);
    if (i >= 0 && j >= 0) {
      rows.splice(Math.max(i, j), 1);
      rows.splice(Math.min(i, j), 1);
      rows.push(`R ${oldP} -> ${newP}`);
    }
  }
  // Rows sort in UTF-8 byte order of their path; an R row sorts by its new path.
  const key = (r: string): string => (r.startsWith('R ') ? r.slice(r.indexOf(' -> ') + 4) : r.slice(2));
  rows.sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  const out = [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];

  if (!check) {
    for (const [p, v] of tree.now) {
      if (v === null) {
        try {
          rmSync(p, { force: true });
        } catch {
          // A delete that cannot happen leaves the run's report as it is.
        }
      } else if (tree.original(p) !== v) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v, 'utf8');
      }
    }
  }
  return { code: 0, out };
}

/** A trial run hands over to the kit's runner; a normal run prints its report. */
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
