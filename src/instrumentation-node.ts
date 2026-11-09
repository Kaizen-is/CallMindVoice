/**
 * Node.js-only startup work, imported by `./instrumentation` on the Node.js
 * runtime only — the edge bundle never sees it (it pulls in native modules
 * such as the Zipformer engine).
 */
import { scheduleBenchmark } from './lib/benchmark';

scheduleBenchmark();
