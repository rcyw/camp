/** Reveal control and bidi characters without interpreting source text as markup. */
const SOURCE_CONTROL = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u;

export function visibleSourceText(value: string, preserveLines = false): string {
  return Array.from(value, character => {
    if (!SOURCE_CONTROL.test(character)) return character;
    if (preserveLines && (character === "\n" || character === "\t")) return character;
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }).join("");
}
