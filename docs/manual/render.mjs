/**
 * A document, as one HTML file Chromium can print.
 *
 * Print rather than draw: the app already ships a PDF writer, but it exists to
 * put a cashbox report on a receipt printer, not to lay out a bilingual manual
 * with photographs in it. Chromium is already here for the tests, it already
 * knows how to hyphenate Arabic and break pages, and `page.pdf()` is the whole
 * of the work — so the manual is a web page, and the PDF falls out of it.
 *
 * Pictures are inlined as data URIs. A PDF is one file that gets emailed to
 * shops, and a manual whose figures live in a folder beside it arrives as a
 * document full of broken images.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BRAND } from './content.mjs';

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** A picture, or nothing at all if it was not taken. */
function figure(shotsDir, language, id, caption) {
  if (!id) return '';
  const file = path.join(shotsDir, language, `${id}.png`);
  if (!existsSync(file)) return '';
  const data = readFileSync(file).toString('base64');
  return `<figure>
      <img src="data:image/png;base64,${data}" alt="${esc(caption || id)}">
    </figure>`;
}

function chapter(ch, language, shotsDir) {
  const heading = ch.heading[language] ?? ch.heading.en;
  const paras = (ch.body?.[language] ?? ch.body?.en ?? [])
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n');
  const steps = ch.steps?.[language] ?? ch.steps?.en;
  const list = steps ? `<ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';

  return `<section class="chapter" id="${ch.id}">
      <h2>${esc(heading)}</h2>
      ${paras}
      ${list}
      ${figure(shotsDir, language, ch.shot, heading)}
    </section>`;
}

/**
 * The whole document.
 *
 * `rtl` flips the page for Arabic — the same switch the app itself uses, so the
 * manual reads in the direction its screenshots do.
 */
export function render({ doc, language, shotsDir, css, cover }) {
  const rtl = language === 'ar';
  const title = doc.title[language] ?? doc.title.en;
  const subtitle = doc.subtitle?.[language] ?? doc.subtitle?.en ?? '';

  const contents = doc.chapters
    .map((ch, i) => {
      const heading = ch.heading[language] ?? ch.heading.en;
      return `<li><span class="n">${i + 1}</span> ${esc(heading)}</li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="${language}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${esc(BRAND.product)} — ${esc(title)}</title>
<style>${css}</style>
</head>
<body>

<section class="cover">
  <div class="mark">${esc(BRAND.product)}</div>
  <h1>${esc(title)}</h1>
  <p class="tagline">${esc(BRAND.tagline[language] ?? BRAND.tagline.en)}</p>
  ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
  <div class="foot">${esc(BRAND.site)}</div>
</section>

${
  cover === 'full'
    ? `<section class="toc">
        <h2>${rtl ? 'المحتويات' : 'Contents'}</h2>
        <ol class="contents">${contents}</ol>
      </section>`
    : ''
}

${doc.chapters.map((ch) => chapter(ch, language, shotsDir)).join('\n')}

<section class="back">
  <p>${
    rtl
      ? 'للمساعدة، تواصل مع المحل الذي زوّدك بهذا النظام.'
      : 'For help, contact whoever supplied you with this system.'
  }</p>
  <p class="site">${esc(BRAND.site)}</p>
</section>

</body>
</html>`;
}
