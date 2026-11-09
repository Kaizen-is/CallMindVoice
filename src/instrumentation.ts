/**
 * Runs once when a server instance starts (Next.js instrumentation).
 *
 * Schedules the deploy benchmark (src/lib/benchmark.ts): a little after boot,
 * in the background, once per build. Nothing here blocks startup.
 *
 * The import must stay inside the NEXT_RUNTIME check: Next.js also compiles
 * this file for the edge runtime, and only a branch it can see is dead is
 * left out of that bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
