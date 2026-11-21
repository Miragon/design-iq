/**
 * When a sample was heard. The voice activity detector counts a channel's
 * samples; this maps such a count back to the wall clock.
 *
 * Audio normally arrives without gaps, and one anchor at the first piece would
 * do. But capture can pause while the clock goes on: the laptop sleeps over the
 * lunch break, an output device changes, a track is muted. Each piece therefore
 * carries the time its last sample was captured (stamped on the audio thread, so
 * a busy page or a busy engine does not shift it), and a piece that begins
 * noticeably later than the samples before it account for starts a new anchor.
 */

/** later than this, a piece starts a new anchor; earlier is jitter of delivery */
const GAP_MS = 2000;

interface Anchor {
  /** the index of a channel's sample */
  sample: number;
  /** when that sample was heard, milliseconds since the epoch */
  at: number;
}

export class SampleClock {
  readonly #rate: number;
  readonly #anchors: Anchor[] = [];
  #samples = 0;

  constructor(sampleRate: number) {
    this.#rate = sampleRate;
  }

  /** a piece of `length` samples whose last sample was captured at `at` */
  piece(length: number, at: number): void {
    const begins = at - (length / this.#rate) * 1000;
    if (this.#anchors.length === 0 || begins - this.timeOf(this.#samples) > GAP_MS) {
      this.#anchors.push({ sample: this.#samples, at: begins });
    }
    this.#samples += length;
  }

  /** when sample `index` of this channel was heard */
  timeOf(index: number): number {
    let anchor = this.#anchors[0];
    if (!anchor) return Number.NaN;
    for (const candidate of this.#anchors) {
      if (candidate.sample > index) break;
      anchor = candidate;
    }
    return anchor.at + ((index - anchor.sample) / this.#rate) * 1000;
  }
}
