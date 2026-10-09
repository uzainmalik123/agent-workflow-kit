import type { WorkStage } from "@agent-workflow-kit/orchestration";
import type { StageProgressCallback } from "./transport.js";

/**
 * What the CLI can show while a stage runs, and the rules for showing it.
 *
 * A stage takes one to fourteen minutes of wall clock, and before this existed the CLI printed
 * nothing at all in that window: from the outside a running stage and a stuck one were the same
 * thing. The events themselves are emitted by the executor (which knows when a stage starts, ends,
 * and fails) and by the transport (which can see the child's stderr as it arrives); this module owns
 * the two rules that make them safe to print:
 *
 * - only a *tool-use* line is ever relayed. OpenCode writes its own headers, permission warnings,
 *   file diffs, and — on some versions — echoes text derived from the prompt to stderr. A line is
 *   relayed only when, with ANSI escapes removed, it begins with one of the tool markers the CLI
 *   itself prints (`→`, `←`, `✱`, `✗`). Prompt prose never begins with one, so prompt text cannot
 *   reach the terminal through this path;
 * - what is relayed is plain and bounded: escapes stripped, one line per event, at most
 *   {@link PROGRESS_LINE_MAX_CHARS} characters. A terminal never receives a control sequence, and a
 *   runaway tool name can never wrap the display.
 *
 * A stream chunk is not a line, so the relay buffers until a newline arrives; an unterminated final
 * line is offered to {@link ActivityRelay.flush} when the process is done.
 */

/** The longest relayed line, in characters, including the ellipsis that marks a cut. */
export const PROGRESS_LINE_MAX_CHARS = 120;

/**
 * The markers OpenCode prints in front of a tool use: `→` a tool that is being called, `←` its
 * result landing, `✱` a tool that ran without a file result, `✗` one that failed. Chosen by what
 * the CLI writes, not by what a message happens to contain.
 */
export const TOOL_USE_MARKERS = ["\u2192", "\u2190", "\u2731", "\u2717"] as const;

const ESCAPE = "\u001b";
const BEL = "\u0007";

/**
 * Removes ANSI escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \`), and the
 * two-byte form (`ESC` plus one byte).
 *
 * Written as a scanner rather than a regular expression, because the whole point is to remove
 * control characters and a regular expression literal carrying them is exactly what a linter
 * should refuse.
 */
export function stripAnsiCodes(text: string): string {
  if (!text.includes(ESCAPE)) {
    return text;
  }

  let out = "";
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);

    if (character !== ESCAPE) {
      out += character;
      index += 1;
      continue;
    }

    index += 1;
    const next = text.charAt(index);

    if (next === "[") {
      index += 1;

      while (index < text.length) {
        const code = text.charCodeAt(index);
        const parameterByte = code >= 0x30 && code <= 0x3f;
        const intermediateByte = code >= 0x20 && code <= 0x2f;
        index += 1;

        if (!parameterByte && !intermediateByte) {
          break;
        }
      }

      continue;
    }

    if (next === "]") {
      index += 1;

      while (index < text.length) {
        const current = text.charAt(index);
        index += 1;

        if (current === BEL) {
          break;
        }

        if (current === ESCAPE && text.charAt(index) === "\\") {
          index += 1;
          break;
        }
      }

      continue;
    }

    if (next !== "") {
      index += 1;
    }
  }

  return out;
}

/**
 * The one line worth showing, or `null` for every line that is not one.
 *
 * Returns the line trimmed of escapes and surrounding whitespace, cut to
 * {@link PROGRESS_LINE_MAX_CHARS}. Anything that is not a tool-use line — an OpenCode header, a
 * diff, a permission warning, the prompt — returns `null` and is never printed.
 */
export function extractToolUseLine(rawLine: string): string | null {
  const plain = stripAnsiCodes(rawLine).trim();

  if (plain.length === 0) {
    return null;
  }

  if (!TOOL_USE_MARKERS.some((marker) => plain.startsWith(marker))) {
    return null;
  }

  if (plain.length <= PROGRESS_LINE_MAX_CHARS) {
    return plain;
  }

  return `${plain.slice(0, PROGRESS_LINE_MAX_CHARS - 1)}\u2026`;
}

export interface LineBuffer {
  /** Adds a chunk and returns the lines it completed, holding the remainder back. */
  readonly push: (chunk: string) => readonly string[];
  /** The unterminated remainder, or `null` when there is none. Empties the buffer. */
  readonly flush: () => string | null;
}

export function createLineBuffer(): LineBuffer {
  let pending = "";

  return {
    push: (chunk: string): readonly string[] => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      return parts;
    },
    flush: (): string | null => {
      const remainder = pending;
      pending = "";
      return remainder.length === 0 ? null : remainder;
    },
  };
}

export interface ActivityRelay {
  /** Feeds one stream chunk. Only `stderr` is relayed; `stdout` is the stage's answer. */
  readonly onChunk: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Offers the final unterminated line, if it is a tool-use line. */
  readonly flush: () => void;
}

/**
 * Turns the child's stderr into `activity` events, as the bytes arrive.
 *
 * `stdout` is deliberately ignored: in the format this adapter asks for it carries the completed
 * answer, which is parsed into the stage result and is not progress. The relay is a pass-through
 * with no memory of its own beyond the partial line, so it cannot become a second transcript.
 */
export function createActivityRelay(stage: WorkStage, emit: StageProgressCallback): ActivityRelay {
  const buffer = createLineBuffer();

  const offer = (line: string): void => {
    const relayed = extractToolUseLine(line);

    if (relayed !== null) {
      emit({ type: "activity", stage, line: relayed });
    }
  };

  return {
    onChunk: (stream: "stdout" | "stderr", chunk: string): void => {
      if (stream !== "stderr") {
        return;
      }

      for (const line of buffer.push(chunk)) {
        offer(line);
      }
    },
    flush: (): void => {
      const remainder = buffer.flush();

      if (remainder !== null) {
        offer(remainder);
      }
    },
  };
}
