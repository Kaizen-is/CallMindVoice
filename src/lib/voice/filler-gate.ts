/**
 * When the "one moment" line plays (Q6): only if the caller is still waiting.
 *
 * The server sends the filler's audio with the turn (pre-recorded, free) and how long to hold it. The
 * page holds it: if the answer's voice starts first, the filler is dropped and the caller hears the
 * answer at once; if `afterMs` passes in silence, the filler plays, and the answer follows it (fillers
 * are short, so it waits a fraction of a second at most). No prediction of the model's speed is needed.
 *
 * Plain class with injectable timers: `tests/web/filler-gate.test.mjs` runs it with a fake clock.
 */

type Schedule = (fn: () => void, ms: number) => unknown;
type Cancel = (handle: unknown) => void;

export class FillerGate {
  private handle: unknown = null;
  private answered = false;
  /** True once the filler has been handed to the player. */
  played = false;

  private readonly play: () => void;
  private readonly schedule: Schedule;
  private readonly cancel: Cancel;

  constructor(
    play: () => void,
    schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    cancel: Cancel = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {
    this.play = play;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  /** The filler arrived; play it after `delayMs` unless the answer's voice starts first. */
  offer(delayMs: number): void {
    if (this.answered || this.played || this.handle !== null) return;
    this.handle = this.schedule(() => {
      this.handle = null;
      if (!this.answered) {
        this.played = true;
        this.play();
      }
    }, Math.max(0, delayMs));
  }

  /** The answer's voice started (or the turn ended): a filler not yet playing is dropped. */
  answer(): void {
    this.answered = true;
    if (this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
  }
}
