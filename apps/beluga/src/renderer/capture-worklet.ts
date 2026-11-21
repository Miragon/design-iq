/**
 * Runs on the audio thread: collects the 128-sample blocks the browser hands
 * out into pieces of a tenth of a second and posts them to the page, each with
 * the time its last sample was captured. The time is taken here, on the audio
 * thread, because the page and the engine may hold a piece up.
 */
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/** what the worklet posts: 16 kHz mono samples and when the last one was captured */
export interface Piece {
  samples: Float32Array;
  at: number;
}

class CaptureProcessor extends AudioWorkletProcessor {
  #piece = new Float32Array(Math.round(sampleRate / 10));
  #filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const block = inputs[0]?.[0];
    if (!block) return true;
    let offset = 0;
    while (offset < block.length) {
      const take = Math.min(block.length - offset, this.#piece.length - this.#filled);
      this.#piece.set(block.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      if (this.#filled === this.#piece.length) {
        this.port.postMessage({ samples: this.#piece, at: Date.now() } satisfies Piece);
        this.#piece = new Float32Array(this.#piece.length);
        this.#filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("beluga-capture", CaptureProcessor);
