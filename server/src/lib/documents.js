import { db } from '../db.js';
import { round2 } from './currency.js';

const TAX_RATE = Number(process.env.TAX_RATE || 0.08);

/**
 * What each document type is for, and what confirming it does.
 *
 * `stock` is the direction stock moves on confirm; `posts` is the sign of the
 * ledger entry. A quotation and a sales order are commitments only — neither
 * touches stock or the books until they become an invoice.
 */
export const DOC_TYPES = {
  quotation: {
    label: 'Quotation',
    prefix: 'QT',
    party: 'customer',
    stock: 0,
    posts: 0,
    convertsTo: ['sales_order', 'sales_invoice'],
  },
  sales_order: {
    label: 'Sales order',
    prefix: 'SO',
    party: 'customer',
    stock: 0,
    posts: 0,
    convertsTo: ['sales_invoice'],
  },
  sales_invoice: {
    label: 'Sales invoice',
    prefix: 'SI',
    party: 'customer',
    stock: -1,
    posts: 1,
    convertsTo: [],
  },
  purchase_invoice: {
    label: 'Purchase invoice',
    prefix: 'PI',
    party: 'supplier',
    stock: 1,
    posts: 1,
    convertsTo: [],
  },
};

export const PARTY_TABLE = { customer: 'customers', supplier: 'suppliers' };

/** Next number for a type, e.g. PI-0007. Sequential per type. */
export function nextDocNumber(docType) {
  const { prefix } = DOC_TYPES[docType];
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM documents WHERE doc_type = ?')
    .get(docType);
  let seq = row.n + 1;

  // Numbers must be unique even if a document was deleted, so step past clashes.
  const exists = db.prepare('SELECT 1 FROM documents WHERE doc_number = ?');
  let candidate = `${prefix}-${String(seq).padStart(4, '0')}`;
  while (exists.get(candidate)) {
    seq += 1;
    candidate = `${prefix}-${String(seq).padStart(4, '0')}`;
  }
  return candidate;
}

/**
 * Validate and price a set of lines.
 *
 * Prices default to the product's current price but may be overridden — a
 * purchase invoice is priced at cost, and quotations often carry a negotiated
 * figure. Quantities allow fractions for weighed goods.
 */
export function buildLines(items, docType) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('A document needs at least one line');
  }

  const lines = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Every line needs a quantity greater than zero');
    }

    let product = null;
    if (item.productId) {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) throw new Error(`Product ${item.productId} not found`);
    }

    const name = item.name || product?.name;
    if (!name) throw new Error('Every line needs a product or a description');

    const fallbackPrice = docType === 'purchase_invoice' ? product?.cost : product?.price;
    const price = item.price !== undefined && item.price !== null ? Number(item.price) : Number(fallbackPrice);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Line "${name}" needs a price of zero or more`);
    }

    lines.push({
      productId: product?.id ?? null,
      name,
      sku: item.sku || product?.sku || null,
      price: round2(price),
      quantity,
      lineTotal: round2(price * quantity),
    });
  }
  return lines;
}

/** Subtotal, discount, tax and total for a set of lines. */
export function totalsFor(lines, discountPercent = 0) {
  const pct = Number(discountPercent) || 0;
  if (pct < 0 || pct > 100) throw new Error('Discount must be between 0 and 100 percent');

  const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const discount = round2(subtotal * (pct / 100));
  const taxable = round2(subtotal - discount);
  const tax = round2(taxable * TAX_RATE);

  return { subtotal, discountPercent: pct, discount, tax, total: round2(taxable + tax) };
}

export function getDocument(id) {
  const doc = db
    .prepare(
      `SELECT d.*, u.name AS user_name,
              COALESCE(c.name, s.name) AS party_name,
              COALESCE(c.phone, s.phone) AS party_phone,
              COALESCE(c.address, s.address) AS party_address,
              src.doc_number AS converted_from_number
       FROM documents d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN customers c ON c.id = d.party_id AND d.party_type = 'customer'
       LEFT JOIN suppliers s ON s.id = d.party_id AND d.party_type = 'supplier'
       LEFT JOIN documents src ON src.id = d.converted_from_id
       WHERE d.id = ?`,
    )
    .get(id);
  if (!doc) return null;

  const items = db.prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY id').all(id);
  const convertedTo = db
    .prepare('SELECT id, doc_type, doc_number, status FROM documents WHERE converted_from_id = ?')
    .all(id);

  return { document: { ...doc, on_account: !!doc.on_account }, items, convertedTo };
}

export { TAX_RATE };
