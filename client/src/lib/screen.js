import { useEffect, useState } from 'react';

/**
 * Whether this is a handset, in the one case CSS cannot answer.
 *
 * Almost every difference between a phone and a counter monitor belongs in a
 * class — `hidden sm:block` and its family do the job without React knowing
 * anything about it. What they cannot do is change *text*, and a placeholder
 * reading "(press / to focus)" on a device with no keyboard is not a layout
 * problem: it is advice that is wrong, taking up the room the useful half of
 * the sentence needed, and getting itself cut off mid-word.
 *
 * Matched against the same 640px Tailwind calls `sm`, so what the class rules
 * do and what this returns cannot disagree about where the line is.
 */
export function useNarrow(query = '(max-width: 639px)') {
  const [narrow, setNarrow] = useState(
    () => globalThis.matchMedia?.(query).matches ?? false,
  );

  useEffect(() => {
    const media = globalThis.matchMedia?.(query);
    if (!media) return undefined;
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return narrow;
}
