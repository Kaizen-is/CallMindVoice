# Golden generators

The Python backend must behave exactly like the TypeScript it replaces (both apps
share the database and the TTS cache). These scripts run the **original
TypeScript** on fixed inputs and write what it produced to
`backend/tests/fixtures/golden_*.json`; the `test_*_parity.py` tests replay the
same inputs in Python and compare.

| Script | Fixture | What it records |
|---|---|---|
| `make-golden-rag.cjs` | `golden_rag.json` | text folding, embeddings (byte-exact), chunking, a 30-chunk corpus and 25 searches |
| `make-golden-text.cjs` | `golden_text.json` | Uzbek number words, spoken-form text, intents, sentiment, local answers, loan identity check and calendar, answer extractor |
| `make-golden-log.cjs` | `golden_mathlog.json` | V8's `Math.log` bits (Python's differs in the last bit) |
| `make-golden-llm.cjs` | `golden_llm.json` | `generateAnswer` / `summarizeCall` / `resolveLlm` with scripted Gemini, OpenAI, Ollama and Claude replies: request bodies (prompts), Claude params, streamed pieces, answers, usage rows |
| `make-golden-speech.cjs` | `golden_speech.json` | TTS cache keys and mtime stamps, TTS renders (own server, Speko, BRB), STT engines and choice, Playground segmenting |
| `make-golden-turn.cjs` | `golden_turn.json` | `runTurn` on a real SQLite file: results, rows written, bus events |
| `make-golden-auth.cjs` | (values in `test_auth_parity.py`) | session cookie, password hash and API key made the TypeScript way |
| `make-golden-workspace.cjs` | `golden_workspace.json` | the console pages' data (overview, analytics, numbers, team, settings, developers, billing) and 62 workspace server-action calls on a seeded SQLite file, frozen clock: answers and rows added/removed |
| `make-golden-url.cjs` | `golden_url.json` | `new URL(input).protocol` (or a throw) for 2,300 inputs — the webhook form's URL check |

How they work: `tsc` compiles the TypeScript to CommonJS in `./out` (gitignored);
each script swaps in recorders for `fetch`, the Anthropic SDK, the usage log or the
database where needed, runs the real code, and writes JSON.

## Regenerate (from the repository root)

```bash
npx tsc -p backend/tools/golden/tsconfig.json
node backend/tools/golden/make-golden-rag.cjs backend/tests/fixtures/golden_rag.json
node backend/tools/golden/make-golden-text.cjs backend/tests/fixtures/golden_rag.json backend/tests/fixtures/golden_text.json
node backend/tools/golden/make-golden-log.cjs backend/tests/fixtures/golden_mathlog.json
node backend/tools/golden/make-golden-llm.cjs backend/tests/fixtures/golden_llm.json
node backend/tools/golden/make-golden-speech.cjs backend/tests/fixtures/golden_speech.json "$TMPDIR/golden-speech"
node backend/tools/golden/make-golden-turn.cjs backend/tests/fixtures/golden_rag.json backend/tests/fixtures/golden_turn.json "$TMPDIR/golden-turn"
node backend/tools/golden/make-golden-url.cjs backend/tests/fixtures/golden_url.json
# workspace: from a checkout of b68a116 (the server actions in ops.ts are thin proxies after the port)
npx tsc -p backend/tools/golden/tsconfig-workspace.json
node --experimental-sqlite backend/tools/golden/make-golden-workspace.cjs backend/tests/fixtures/golden_workspace.json "$TMPDIR/golden-workspace"
```

(On Windows use a folder such as `%TEMP%\golden-speech` for the last argument.)
A `TS2688 … 'node'` warning from `tsc` is harmless when `@types/node` is not
installed; the JavaScript is still written.

Regenerating gives identical files except for values that are random or depend on
the temp folder (call ids; the clone-voice cache keys, which contain the sample's
absolute path). The tests already allow for those. **If a regenerated fixture
changes anything else, the TypeScript behaviour changed** — port that change to
Python in the same commit.

## Porting a new module

1. Add the `.ts` file to `files` in `tsconfig.json`.
2. Write a generator that runs it on inputs covering the edge cases (stub
   `server-only`, `@/lib/db`, `@/lib/usage-log`, `fetch`, `@anthropic-ai/sdk` as the
   existing scripts do; a non-exported function can be exposed by appending
   `exports.__name = name;` to the compiled file, as `make-golden-speech.cjs` does
   for the TTS cache key).
3. Write `backend/tests/test_<area>_parity.py` that replays the fixture.
4. Break the Python on purpose once (one character of a prompt, one constant) and
   check the test fails, then restore it.

Where JavaScript and Python differ (UTF-16 string length, `Math.round`, `\s` and
`\b`, `toFixed`, `JSON.stringify` numbers, `Math.log`, `trim`, truthiness, …):
`backend/app/jscompat.py`.
