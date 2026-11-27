// The Q4 waits (src/lib/voice/endpointing.ts) for turn_lab_eval.py: reads [{heard, asked}] as JSON on
// stdin, prints the wait in ms for each. Run with: node --no-warnings --experimental-strip-types
import { pauseFor } from '../../src/lib/voice/endpointing.ts';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const rows = JSON.parse(input);
process.stdout.write(JSON.stringify(rows.map((r) => pauseFor(r.heard, r.asked ?? '').ms)));
