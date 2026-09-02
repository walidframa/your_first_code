/**
 * The numbers off the boxes, as handsets.
 *
 * This has to agree with `parseImeiList` in server/src/lib/units.js exactly. A
 * screen that counts two where the confirm counts one is a shop being told it
 * is wrong by the thing that just told it it was right, so the rules are
 * repeated here rather than approximated:
 *
 *  - **A comma, slash, semicolon or pipe** joins two numbers into one dual-SIM
 *    handset, and takes the spaces beside it.
 *  - **A newline** always starts a new handset.
 *  - **A space** depends on length: a whole fifteen-digit number stands alone,
 *    anything shorter is a fragment of the number being built — because that is
 *    how an IMEI is printed on the box, `35 6001 0001 0001 1`.
 */

/** How long a number has to be before it stands on its own. */
const WHOLE_IMEI = 15;

/** Digits and letters only — spaces and dashes are how it is printed, not part of it. */
export const digitsOf = (value) => String(value ?? '').replace(/[\s-]/g, '').toUpperCase();

/** Split one token into the one or two numbers on a single box. */
function pairOf(token) {
  const [first, second] = String(token).split(/[,/;|]/).map(digitsOf);
  return { imei: first || '', imei2: second || '' };
}

/** Every handset in a typed or scanned box of numbers. */
export function parseImeis(text) {
  const handsets = [];

  for (const line of String(text ?? '').split(/[\r\n]+/)) {
    const tokens = line.replace(/\s*[,/;|]\s*/g, ',').split(/\s+/).filter(Boolean);

    let buffer = '';
    const flush = () => {
      if (!buffer) return;
      const pair = pairOf(buffer);
      if (pair.imei) handsets.push(pair);
      buffer = '';
    };

    for (const token of tokens) {
      // Measured on the token's first number: a pair separator has already
      // glued a dual-SIM's second number on, and "1,356…9" is a fragment
      // however long the token reads.
      const head = digitsOf(token.split(',')[0]);
      if (buffer && (digitsOf(buffer).length >= WHOLE_IMEI || head.length >= WHOLE_IMEI)) flush();
      buffer += token;
    }
    flush();
  }

  return handsets;
}

export const imeiCount = (text) => parseImeis(text).length;

/**
 * Handsets back into the one string the document stores.
 *
 * One per line, the pair joined by a comma — which is exactly what `parseImeis`
 * reads back, so a value can go round the fields and the wire without drifting.
 * Empty boxes are dropped rather than written as blank lines: a handset with no
 * number is not a handset, and the count under the fields has to agree with the
 * confirm.
 */
export function formatImeis(handsets) {
  return (handsets || [])
    .map(({ imei, imei2 }) => [digitsOf(imei), digitsOf(imei2)].filter(Boolean).join(','))
    .filter(Boolean)
    .join('\n');
}

/**
 * The list padded out to one entry per phone on the line.
 *
 * The fields are drawn from the quantity, not from what has been typed so far —
 * a delivery of three handsets shows three pairs of boxes from the moment the
 * quantity says three, and typing fills them in rather than creating them.
 */
export function handsetSlots(text, quantity) {
  const found = parseImeis(text);
  const wanted = Math.max(0, Math.floor(Number(quantity) || 0));
  const slots = [];
  for (let i = 0; i < Math.max(wanted, found.length); i += 1) {
    slots.push(found[i] || { imei: '', imei2: '' });
  }
  return slots;
}
