import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import { codeFor, detectFormat } from '../lib/barcode';
import { money } from './ui';
import { lbp } from '../context/SettingsContext';
import { usePageSize } from '../lib/pageSize';

/**
 * One barcode, drawn by JsBarcode into an inline SVG.
 *
 * The symbology is detected per code rather than assumed, and JsBarcode is
 * asked not to draw its own text so the number can be styled to fit the label.
 */
function Barcode({ value, height, width = 1.4 }) {
  const ref = useRef(null);

  useEffect(() => {
    const format = detectFormat(value);
    if (!ref.current || !format) return;
    try {
      JsBarcode(ref.current, String(value), {
        format,
        width,
        height,
        displayValue: false,
        margin: 0,
      });
    } catch {
      // A code JsBarcode still refuses is shown as text by the caller.
      ref.current.innerHTML = '';
    }
  }, [value, height, width]);

  return <svg ref={ref} className="block max-w-full" />;
}

/**
 * A single label: the shop's name if it prints, the product name, the price in
 * both currencies, the barcode and its number.
 *
 * Which of those actually appear, and how big each one is, comes from the
 * size's `style` — so a shop that wants nothing but a price and bars gets a
 * label with nothing but a price and bars, at the size it asked for.
 */
export function Label({ product, size, rate, showLbp = true, shopName = '' }) {
  const code = codeFor(product);
  const priceLbp = rate ? Math.round((product.price * rate) / 1000) * 1000 : 0;
  const style = size.style || {};
  // The checkbox on the screen and the style both have a say; either turning it
  // off turns it off, so the old caller keeps working unchanged.
  const withLbp = showLbp && style.lbp !== false;

  return (
    <div
      className="label-one flex flex-col items-center justify-between overflow-hidden bg-white text-center"
      style={{
        width: `${size.width}mm`,
        height: `${size.height}mm`,
        padding: `${size.padding}mm`,
      }}
    >
      {style.shop && shopName && (
        <span
          className="label-shop w-full truncate font-semibold tracking-wide text-black uppercase"
          style={{ fontSize: `${size.shopPt}pt`, lineHeight: 1.1 }}
        >
          {shopName}
        </span>
      )}

      {style.name !== false && (
        <span
          className="w-full leading-tight font-semibold text-black"
          style={{
            fontSize: `${size.namePt}pt`,
            lineHeight: 1.1,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: size.nameLines,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {product.name}
        </span>
      )}

      {style.price !== false && (
        <span className="font-bold text-black" style={{ fontSize: `${size.pricePt}pt`, lineHeight: 1 }}>
          {money(product.price)}
        </span>
      )}

      {withLbp && rate > 0 && (
        <span className="text-black" style={{ fontSize: `${size.subPt}pt`, lineHeight: 1 }}>
          {lbp(priceLbp)}
        </span>
      )}

      {style.barcode === false ? null : code ? (
        <div className="flex w-full flex-col items-center">
          <Barcode value={code} height={size.barcodeHeight} width={size.barWidth} />
          {style.code !== false && (
            <span
              className="tracking-wider text-black"
              style={{ fontSize: `${size.codePt}pt`, lineHeight: 1, marginTop: '0.3mm' }}
            >
              {code}
            </span>
          )}
        </div>
      ) : (
        <span style={{ fontSize: '6pt' }} className="text-slate-400">
          No barcode or SKU
        </span>
      )}
    </div>
  );
}

/**
 * The printable sheet. Only this element survives the print stylesheet, so the
 * app's own chrome never appears on the page.
 *
 * Two modes, because the stock differs:
 *
 *  - `sheet`: an A4 page of die-cut labels (Avery-style), laid out as a grid.
 *  - `roll`:  a label printer, where **one physical label is one page**. Each
 *             label gets its own page and the page itself is sized to the label,
 *             otherwise the whole grid is squeezed onto a single label.
 *
 * The page size depends on the size chosen, so it is claimed from lib/pageSize
 * rather than written into a stylesheet ahead of the choice.
 */
export default function LabelSheet({ labels, size, rate, showLbp, mode = 'sheet', shopName = '' }) {
  usePageSize(
    mode === 'roll'
      ? `@page { size: ${size.width}mm ${size.height}mm; margin: 0; }`
      : '@page { size: A4; margin: 6mm; }',
  );

  return (
    <>
      <div
        className={`label-sheet bg-white ${mode === 'roll' ? 'mode-roll' : 'mode-sheet grid'}`}
        style={
          mode === 'roll'
            ? undefined
            : {
                gridTemplateColumns: `repeat(${size.perRow}, ${size.width}mm)`,
                gap: '2mm',
                justifyContent: 'center',
              }
        }
      >
        {labels.map((product, i) => (
          <Label
            key={`${product.id}-${i}`}
            product={product}
            size={size}
            rate={rate}
            showLbp={showLbp}
            shopName={shopName}
          />
        ))}
      </div>
    </>
  );
}
