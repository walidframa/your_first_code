/**
 * A picture for a recharge card, drawn rather than shipped.
 *
 * A cashier finds a card by its colour long before they read its value — the
 * real ones are colour-coded per denomination for exactly that reason, and a
 * wall of identical tiles is slower than a wall of pictures.
 *
 * Drawn as an SVG data URI because the alternative is shipping the carriers'
 * own card artwork, which is theirs and not ours to redistribute. This is a
 * plain coloured face carrying the two facts that matter — whose card and how
 * much credit — and any shop that would rather see a photograph of the real
 * thing can replace it from the Cards screen in two presses.
 *
 * No dependencies, a few hundred bytes each, and it goes in `image_url` like
 * any other picture, so every screen that already shows one shows this.
 */

/*
 * A hue per denomination, in the order the ladder runs. Chosen to be far apart
 * rather than pretty: the whole job is telling six tiles apart at a glance
 * across a counter.
 */
const FACES = [
  ['#f4c025', '#e0a800', '#1f2937'],
  ['#2f6fed', '#1a4bbd', '#ffffff'],
  ['#1f9d55', '#137a3f', '#ffffff'],
  ['#7c4dbd', '#5b3494', '#ffffff'],
  ['#12a3a3', '#0b7d7d', '#ffffff'],
  ['#e0559b', '#bd3a7c', '#ffffff'],
];

/** Carrier accent, kept to a dot so nothing here imitates a carrier's mark. */
const CARRIER_DOT = { Alfa: '#e11d48', Touch: '#7c3aed' };

/**
 * The face for one card.
 *
 * `index` picks the colour, so the same denomination looks the same for both
 * carriers and the shelf reads as one ladder.
 */
export function rechargeCardFace({ carrier, credits, index = 0 }) {
  const [top, bottom, ink] = FACES[index % FACES.length];
  const dot = CARRIER_DOT[carrier] || '#334155';
  // Padded to two digits the way the printed cards are: "$03⁷⁹", not "$3⁷⁹".
  const [whole, cents] = Number(credits).toFixed(2).padStart(5, '0').split('.');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" width="320" height="200">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
</linearGradient></defs>
<rect width="320" height="200" rx="18" fill="url(#g)"/>
<path d="M320 0 L320 90 L150 200 L40 200 Z" fill="#ffffff" opacity="0.08"/>
<text x="26" y="104" font-family="Helvetica,Arial,sans-serif" font-size="62" font-weight="700" fill="${ink}">$${whole}<tspan font-size="30" dy="-28">${cents}</tspan></text>
<text x="26" y="140" font-family="Helvetica,Arial,sans-serif" font-size="27" font-weight="600" fill="${ink}" opacity="0.92">${carrier}</text>
<text x="26" y="168" font-family="Helvetica,Arial,sans-serif" font-size="15" fill="${ink}" opacity="0.7">Recharge card</text>
<circle cx="272" cy="150" r="22" fill="${dot}" opacity="0.9"/>
</svg>`;

  // Encoded rather than base64: it stays readable in the database, and an SVG
  // this small is smaller as text than it would be encoded.
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\n/g, ''))}`;
}
