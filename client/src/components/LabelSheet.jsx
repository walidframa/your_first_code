import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import { codeFor, detectFormat } from '../lib/barcode';
import { money } from './ui';
import { lbp } from '../context/SettingsContext';

/**
 * Label sizes, in millimetres, matching common sheet and roll stock.
 * `perRow` is what fits across an A4 sheet at these widths.
 */
export const LABEL_SIZES = {
  small: { key: 'small', label: 'Small · 38 × 21 mm', width: 38, height: 21.2, perRow: 5, barcodeHeight: 22 },
  medium: { key: 'medium', label: 'Medium · 63.5 × 34 mm', width: 63.5, height: 33.9, perRow: 3, barcodeHeight: 34 },
  large: { key: 'large', label: 'Large · 70 × 42 mm', width: 70, height: 42, perRow: 2, barcodeHeight: 44 },
  thermal: { key: 'thermal', label: 'Thermal roll · 50 × 30 mm', width: 50, height: 30, perRow: 3, barcodeHeight: 30 },
};

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

/** A single label: name, price in both currencies, barcode and its number. */
export function Label({ product, size, rate, showLbp = true }) {
  const code = codeFor(product);
  const priceLbp = rate ? Math.round((product.price * rate) / 1000) * 1000 : 0;

  return (
    <div
      className="label-one flex flex-col items-center justify-between overflow-hidden bg-white text-center"
      style={{
        width: `${size.width}mm`,
        height: `${size.height}mm`,
        padding: '1.5mm',
      }}
    >
      <span
        className="w-full leading-tight font-semibold text-black"
        style={{
          fontSize: size.width > 55 ? '9pt' : '7pt',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {product.name}
      </span>

      <span className="font-bold text-black" style={{ fontSize: size.width > 55 ? '13pt' : '10pt' }}>
        {money(product.price)}
      </span>

      {showLbp && rate > 0 && (
        <span className="text-black" style={{ fontSize: size.width > 55 ? '8pt' : '6pt' }}>
          {lbp(priceLbp)}
        </span>
      )}

      {code ? (
        <div className="flex w-full flex-col items-center">
          <Barcode value={code} height={size.barcodeHeight} width={size.width > 55 ? 1.6 : 1.1} />
          <span
            className="tracking-wider text-black"
            style={{ fontSize: size.width > 55 ? '7pt' : '5pt', marginTop: '0.5mm' }}
          >
            {code}
          </span>
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
 * The page size cannot come from a stylesheet written ahead of time because it
 * depends on the size chosen, so the @page rule is emitted here.
 */
export default function LabelSheet({ labels, size, rate, showLbp, mode = 'sheet' }) {
  const pageRule =
    mode === 'roll'
      ? `@page { size: ${size.width}mm ${size.height}mm; margin: 0; }`
      : '@page { size: A4; margin: 6mm; }';

  return (
    <>
      <style>{pageRule}</style>
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
          <Label key={`${product.id}-${i}`} product={product} size={size} rate={rate} showLbp={showLbp} />
        ))}
      </div>
    </>
  );
}
