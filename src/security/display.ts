const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Render invisible direction-changing characters as explicit escape codes. */
export function escapeBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === undefined ? "\\u0000" : `\\u${codePoint.toString(16).padStart(4, "0")}`;
  });
}

/** Neutralize terminal control channels while preserving ordinary newlines/tabs. */
export function sanitizeTerminalText(value: string, maximum = 4_096): string {
  return escapeBidiControls(value)
    .slice(0, maximum)
    .replace(/\r/gu, "\n")
    .replace(/\u001b/gu, "<ESC>")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "\uFFFD");
}
