export const HUMAN_SPEECH_SEGMENT_MAX_CHARS = 96;
export const HUMAN_SPEECH_SOFT_BOUNDARY_MIN_CHARS = 24;

const TERMINAL_BOUNDARY = /[。！？!?；;\n]/u;
const SOFT_BOUNDARY = /[，,、：:]/u;

function codePointOffset(text: string, count: number): number {
  let offset = 0;
  let seen = 0;
  for (const character of text) {
    if (seen >= count) break;
    offset += character.length;
    seen++;
  }
  return offset;
}

function firstBoundary(
  text: string,
  pattern: RegExp,
  minimumCharacters = 0,
): number | null {
  let characters = 0;
  let offset = 0;
  for (const character of text) {
    characters++;
    offset += character.length;
    if (characters >= minimumCharacters && pattern.test(character)) return offset;
  }
  return null;
}

function trimSegment(value: string): string {
  return value.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/**
 * Turns arbitrary model deltas into bounded, natural speech units. Only a
 * complete terminal clause, a sufficiently long soft clause, or a hard bound
 * is emitted; callers remain responsible for policy validation before audio.
 */
export class HumanSpeechSegmenter {
  #buffer = "";

  public push(delta: string): readonly string[] {
    if (typeof delta !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(delta)) {
      throw new TypeError("Human speech delta must be a control-free string");
    }
    this.#buffer += delta;
    return this.#drain(false);
  }

  public finish(): readonly string[] {
    const output = this.#drain(true);
    if (this.#buffer.length !== 0) throw new Error("speech segmenter failed to drain its buffer");
    return output;
  }

  public discard(): void {
    this.#buffer = "";
  }

  #drain(final: boolean): readonly string[] {
    const output: string[] = [];
    while (this.#buffer.length > 0) {
      const terminal = firstBoundary(this.#buffer, TERMINAL_BOUNDARY);
      const soft = terminal === null
        ? firstBoundary(this.#buffer, SOFT_BOUNDARY, HUMAN_SPEECH_SOFT_BOUNDARY_MIN_CHARS)
        : null;
      const characters = [...this.#buffer].length;
      const boundary = terminal ?? soft ?? (
        characters >= HUMAN_SPEECH_SEGMENT_MAX_CHARS
          ? codePointOffset(this.#buffer, HUMAN_SPEECH_SEGMENT_MAX_CHARS)
          : final ? this.#buffer.length : null
      );
      if (boundary === null) break;
      const segment = trimSegment(this.#buffer.slice(0, boundary));
      this.#buffer = this.#buffer.slice(boundary).replace(/^\s+/u, "");
      if (segment.length > 0) output.push(segment);
    }
    return output;
  }
}
