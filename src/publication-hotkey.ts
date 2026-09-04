/**
 * Parsing a dictation shortcut spelling (`option+z`) into what the bridge posts.
 *
 * Its own module so `src/runner.ts` and `src/publication.ts` share one
 * implementation without the runner importing the orchestrator - which would pull the
 * whole batch machinery, and `Bun.spawn`, into the process that measures clips.
 *
 * Parsed rather than accepted as a raw key code because a key code is unreadable and
 * the cost of getting it wrong is a whole night of timeouts: Wispr Flow exposes no
 * supported automation API, so a shortcut that does not match the one configured in
 * Flow produces no error, only silence and a timeout on every clip.
 */

/**
 * macOS virtual key codes for the keys a dictation shortcut plausibly uses.
 *
 * A small allow-list rather than a full keyboard map, because an unknown key must be an
 * error at parse time. The committed archive used `space` (49); SPEC §5 pins `z` (6)
 * for the v2 batch.
 */
export const KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  return: 36,
  tab: 48,
  space: 49,
};

/**
 * Wispr Flow's dictation shortcut. **The only default, for both entry points.**
 *
 * Option+Z, confirmed against the installed product. It lives here rather than beside
 * either caller because two defaults is the trap: a direct `bun run benchmark` posting
 * a shortcut Flow no longer listens on produces four hundred timeouts, not an error.
 *
 * The runs under `results/` were measured with Option+Space and are not v2-comparable
 * for that reason as well as the ~85 ms keydown-edge bias. There is no fallback to it -
 * `--flow-hotkey` states a different shortcut when one is needed, and every run records
 * the key code and modifiers it used.
 */
export const DEFAULT_FLOW_HOTKEY = "option+z";

export const MODIFIERS = ["command", "control", "fn", "option", "shift"] as const;

export type Modifier = (typeof MODIFIERS)[number];

/**
 * Spellings that mean the same modifier as one of the canonical five.
 *
 * `alt` and `opt` are what the key is labelled on most keyboards and in most other
 * tools, so they are the two an operator reaches for. Rejecting them was safe - the
 * error names the modifier and lists the known ones - but it is a refusal at the start
 * of an overnight command for no reason. `cmd` and `ctrl` are here for the same reason.
 * Normalised to the canonical spelling, so the recorded value is one thing.
 */
const MODIFIER_ALIASES: Record<string, Modifier> = {
  alt: "option",
  opt: "option",
  cmd: "command",
  ctrl: "control",
};

export interface Hotkey {
  keyCode: number;
  modifiers: Modifier[];
  /** The spelling the operator typed, echoed back so a plan preview is checkable. */
  spec: string;
}

/**
 * `option+z` into a key code and its modifiers. The key is the last segment.
 *
 * At least one modifier is required. A bare key would be typed into whatever has focus,
 * which during a benchmark is the receiver window: the harness would append a stray
 * character to the text it is measuring and then blame the product for it.
 */
export function parseHotkey(spec: string): Hotkey {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (!key || modifiers.length === 0) {
    throw new Error(
      `--flow-hotkey ${spec} must name at least one modifier and a key, e.g. option+z. ` +
        `A bare key would be typed into the receiver window the harness is measuring.`,
    );
  }
  const keyCode = KEY_CODES[key];
  if (keyCode === undefined) {
    throw new Error(
      `--flow-hotkey ${spec}: unknown key "${key}". Known keys: ${Object.keys(KEY_CODES).join(", ")}.`,
    );
  }
  const canonical: Modifier[] = [];
  for (const modifier of modifiers) {
    const resolved = (MODIFIERS as readonly string[]).includes(modifier)
      ? (modifier as Modifier)
      : MODIFIER_ALIASES[modifier];
    if (!resolved) {
      throw new Error(
        `--flow-hotkey ${spec}: unknown modifier "${modifier}". Known: ${MODIFIERS.join(", ")} ` +
          `(aliases: ${Object.keys(MODIFIER_ALIASES).join(", ")}).`,
      );
    }
    if (!canonical.includes(resolved)) canonical.push(resolved);
  }
  return { keyCode, modifiers: canonical, spec };
}
