/**
 * The gateway's limits on what a run posts, in one place.
 *
 * 🔴 **Each one is the gateway's own `@MaxLength`, and a value past it costs a
 * batch.** `aeo-backend`'s `insights-run-event.dto.ts` validates every finding
 * in a resolutions event, and one field too long answers the WHOLE event with
 * a 400 the runtime never retries — every finding in it lost to one item's
 * string. So the runtime holds every value it posts to these, and they live
 * here rather than beside each use, where two spellings of one limit drift.
 */

/** `ResolutionDto.failure`. */
export const MAX_FAILURE_LENGTH = 512;

/**
 * `text` held to `max` characters: as it is when it fits, otherwise cut and
 * ended with "…", so a reader can see it was cut.
 */
export function boundText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
