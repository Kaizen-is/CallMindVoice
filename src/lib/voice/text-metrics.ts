/**
 * Comparing transcripts in the STT lab: a word diff between two outputs, and
 * WER / CER against a human reference. Only computed when a reference exists:
 * without one there is no accuracy number to show. Unit-tested in
 * tests/web/text-metrics.test.mjs.
 */

/** Lower case, apostrophe variants unified (o‘ / o' / oʻ), punctuation dropped. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(text: string): string[] {
  const n = normalizeText(text);
  return n ? n.split(' ') : [];
}

/** Levenshtein distance over tokens. */
export function editDistance<T>(a: T[], b: T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Word error rate of `hypothesis` against `reference` (null without a reference). */
export function wer(reference: string, hypothesis: string): number | null {
  const ref = words(reference);
  if (!ref.length) return null;
  return editDistance(ref, words(hypothesis)) / ref.length;
}

/** Character error rate (spaces kept as characters), null without a reference. */
export function cer(reference: string, hypothesis: string): number | null {
  const ref = [...normalizeText(reference)];
  if (!ref.length) return null;
  return editDistance(ref, [...normalizeText(hypothesis)]) / ref.length;
}

export type DiffPart = { kind: 'same' | 'removed' | 'added'; text: string };

/** Word-level diff from `before` to `after` (LCS), for showing what processing changed. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.trim() ? before.trim().split(/\s+/) : [];
  const b = after.trim() ? after.trim().split(/\s+/) : [];
  const key = (w: string) => normalizeText(w);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = key(a[i]) === key(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += ` ${text}`;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) {
      push('same', b[j]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('removed', a[i++]);
    else push('added', b[j++]);
  }
  while (i < a.length) push('removed', a[i++]);
  while (j < b.length) push('added', b[j++]);
  return out;
}
