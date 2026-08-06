/**
 * Structure-aware chunking.
 *
 * Naive fixed-width splitting is the single biggest cause of bad RAG answers:
 * it cuts a price list in half and orphans the heading that gives it meaning.
 *
 * Real contact-centre documents are overwhelmingly *line-oriented* — one fact
 * per line under a short heading — rather than flowing prose. So we:
 *   1. detect headings using their surroundings, not just their casing;
 *   2. keep each line its own unit unless it is clearly a wrapped continuation;
 *   3. pack units up to a target size, carrying the heading into every chunk;
 *   4. overlap consecutive chunks so a fact on a boundary stays retrievable.
 */
import { estimateTokens, sentences } from './text';

export interface RawChunk {
  heading: string | null;
  text: string;
  tokenCount: number;
}

const TARGET_TOKENS = 170;
const MAX_TOKENS = 280;
const OVERLAP_TOKENS = 30;

const TERMINAL = /[.!?:;,]$/;
const BULLET = /^([-*•·]|\d+[.)])\s+/;
const PRICE = /\d[\d\s.,]*\s*(so'm|som|sum|uzs|usd|\$|€|rub|руб|%)/i;

function isBlank(line: string) {
  return !line.trim();
}

/**
 * A heading is recognised from its context, not its capitalisation — Uzbek and
 * Russian section titles are ordinary sentence case, so a caps ratio test
 * misses almost all of them.
 */
function isHeading(lines: string[], i: number): boolean {
  const raw = lines[i];
  const t = raw.trim();
  if (!t) return false;

  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (/^(\d+(\.\d+)*)[.)]\s+\S/.test(t) && t.length <= 90) return true;
  if (/^[A-ZА-ЯЎҚҒҲ][^a-zа-я]*$/.test(t) && t.replace(/[^\p{L}]/gu, '').length >= 4 && t.length <= 80)
    return true;

  // Contextual heading: a short, unpunctuated line that opens a block.
  if (t.length > 70) return false;
  if (TERMINAL.test(t)) return false;
  if (BULLET.test(t)) return false;
  if (PRICE.test(t)) return false;
  if (t.split(/\s+/).length > 8) return false;
  if (!/^[\p{Lu}\p{N}]/u.test(t)) return false;

  const prevBlank = i === 0 || isBlank(lines[i - 1]);
  const nextFilled = i + 1 < lines.length && !isBlank(lines[i + 1]);
  return prevBlank && nextFilled;
}

/** A line continues the previous one when the previous line was left hanging. */
function isContinuation(prev: string, cur: string): boolean {
  if (!prev) return false;
  if (BULLET.test(cur)) return false;
  if (TERMINAL.test(prev.trim())) return false;
  return /^[\p{Ll}]/u.test(cur.trim());
}

interface Block {
  heading: string | null;
  units: string[];
}

function toBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let heading: string | null = null;
  let units: string[] = [];

  const flushBlock = () => {
    if (units.length) blocks.push({ heading, units });
    units = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;

    if (isHeading(lines, i)) {
      flushBlock();
      heading = line.trim().replace(/^#{1,6}\s+/, '');
      continue;
    }

    const clean = line.trim().replace(/\s+/g, ' ');
    const prev = units[units.length - 1];
    if (prev && isContinuation(prev, clean)) {
      units[units.length - 1] = `${prev} ${clean}`;
    } else {
      units.push(clean);
    }
  }
  flushBlock();
  return blocks;
}

function splitOversized(unit: string): string[] {
  if (estimateTokens(unit) <= MAX_TOKENS) return [unit];
  const out: string[] = [];
  let current = '';
  for (const s of sentences(unit)) {
    if (current && estimateTokens(`${current} ${s}`) > TARGET_TOKENS) {
      out.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) out.push(current);
  return out.length ? out : [unit];
}

export function chunkDocument(text: string, title: string): RawChunk[] {
  const blocks = toBlocks(text);
  const chunks: RawChunk[] = [];

  for (const block of blocks) {
    const units = block.units.flatMap(splitOversized);
    const prefix = block.heading ? `${block.heading}\n` : '';
    let current: string[] = [];
    let currentTokens = 0;

    const emit = (withOverlap: boolean) => {
      if (!current.length) return;
      const body = current.join('\n');
      chunks.push({
        heading: block.heading,
        text: `${prefix}${body}`.trim(),
        tokenCount: estimateTokens(prefix + body),
      });
      if (!withOverlap) {
        current = [];
        currentTokens = 0;
        return;
      }
      // Carry the tail forward so a fact split across a boundary is still found.
      const tail: string[] = [];
      let tailTokens = 0;
      for (let i = current.length - 1; i >= 0 && tailTokens < OVERLAP_TOKENS; i--) {
        tail.unshift(current[i]);
        tailTokens += estimateTokens(current[i]);
      }
      const overlapping = tail.length < current.length;
      current = overlapping ? tail : [];
      currentTokens = overlapping ? tailTokens : 0;
    };

    for (const unit of units) {
      const t = estimateTokens(unit);
      if (currentTokens + t > TARGET_TOKENS && current.length) emit(true);
      current.push(unit);
      currentTokens += t;
    }
    emit(false);
  }

  // Degenerate input (a single unstructured blob) — fall back to windows.
  if (!chunks.length && text.trim()) {
    for (const part of splitOversized(text.replace(/\s+/g, ' ').trim())) {
      chunks.push({ heading: title, text: part, tokenCount: estimateTokens(part) });
    }
  }

  return chunks
    .map((c) => ({ ...c, text: c.text.trim() }))
    .filter((c) => c.text.replace(/\s/g, '').length > 20);
}

/** FAQ pairs become one chunk each — the highest-precision shape for voice. */
export function chunkFaq(pairs: Array<{ q: string; a: string }>): RawChunk[] {
  return pairs
    .filter((p) => p.q.trim() && p.a.trim())
    .map((p) => ({
      heading: p.q.trim(),
      text: `${p.q.trim()}\n${p.a.trim()}`,
      tokenCount: estimateTokens(p.q + p.a),
    }));
}
