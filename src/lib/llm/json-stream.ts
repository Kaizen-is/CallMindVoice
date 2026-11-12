/**
 * Streaming structured answers: every engine returns the same JSON object
 * (`{answer, answered, usedExcerpts}`), and the voice wants the `answer`
 * text while it is still being written. This follows the growing JSON and
 * hands on the answer as it appears — shared by the OpenAI, Ollama, Gemini
 * and Claude streaming paths.
 */

/**
 * Follows a growing JSON text and reports the `answer` string's value as it
 * appears, decoded. Escapes split across pieces wait for their next piece.
 */
export function answerExtractor(onAnswer: (delta: string) => void): (raw: string) => void {
  let at = -1; // index of the first character of the value, once found
  let closed = false;
  return (raw) => {
    if (closed) return;
    if (at < 0) {
      const m = /"answer"\s*:\s*"/.exec(raw);
      if (!m) return;
      at = m.index + m[0].length;
    }
    let out = '';
    let i = at;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') {
        closed = true;
        break;
      }
      if (c !== '\\') {
        out += c;
        i += 1;
        continue;
      }
      if (i + 1 >= raw.length) break;
      const e = raw[i + 1];
      if (e === 'u') {
        if (i + 6 > raw.length) break;
        out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16) || 32);
        i += 6;
      } else {
        out += e === 'n' ? '\n' : e === 't' ? ' ' : e === 'r' ? '' : e;
        i += 2;
      }
    }
    at = i;
    if (out) onAnswer(out);
  };
}
