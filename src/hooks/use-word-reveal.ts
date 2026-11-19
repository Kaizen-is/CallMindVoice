'use client';

/**
 * Shows a growing transcript one word at a time. Streaming STT answers in bursts (several words
 * at once, or a word that is revised); this reveals the new words one after another so the
 * caller sees them appear, and trims back to the last shared word when the model revises.
 */
import { useEffect, useRef, useState } from 'react';

/** Milliseconds per revealed word; faster when the transcript is far ahead of what is shown. */
const WORD_MS = 70;
const CATCH_UP_MS = 30;

/** The longest prefix of both strings that ends at a word boundary (or `a` when `b` extends it). */
function sharedPrefix(a: string, b: string): string {
  if (b.startsWith(a)) return a;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = a.slice(0, i);
  const space = cut.lastIndexOf(' ');
  return space >= 0 ? cut.slice(0, space + 1) : '';
}

/** `shown` plus the next word of `target` (a partial word is completed first). */
function nextWord(shown: string, target: string): string {
  const rest = target.slice(shown.length);
  const word = rest.match(/^\s*\S+/);
  return shown + (word ? word[0] : rest);
}

export function useWordReveal(target: string): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    if (!target) {
      shownRef.current = '';
      setShown('');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      const base = sharedPrefix(shownRef.current, target);
      if (base.length >= target.length) {
        shownRef.current = target;
        setShown(target);
        return;
      }
      const next = nextWord(base, target);
      shownRef.current = next;
      setShown(next);
      const wordsLeft = target.slice(next.length).trim().split(/\s+/).filter(Boolean).length;
      if (next.length < target.length) timer = setTimeout(step, wordsLeft > 6 ? CATCH_UP_MS : WORD_MS);
    };
    step();
    return () => clearTimeout(timer);
  }, [target]);

  return shown;
}
