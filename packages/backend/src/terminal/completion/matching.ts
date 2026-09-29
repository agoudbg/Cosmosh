/**
 * Scores exact literal text without trimming meaningful filename/argument whitespace.
 * @param query User's literal prefix. @param candidate Source text. @param fuzzyMatch Allow ordered non-adjacent characters.
 * @returns Positive relevance, or zero when no supported match exists. Empty queries retain source order.
 */
export const scoreCompletionMatch = (query: string, candidate: string, fuzzyMatch: boolean): number => {
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  if (!haystack) return 0;
  if (!needle) return 200;
  if (haystack.startsWith(needle)) return 1000 - Math.min(80, haystack.length - needle.length);
  if (haystack.includes(needle)) return 600 - Math.min(120, haystack.length - needle.length);
  if (!fuzzyMatch) return 0;
  const characters = Array.from(needle);
  let matched = 0;
  let gaps = 0;
  for (const character of haystack) {
    if (character === characters[matched]) matched += 1;
    else gaps += 1;
    if (matched === characters.length) return Math.max(120, 260 - gaps);
  }
  return 0;
};
