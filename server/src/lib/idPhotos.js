/**
 * The seller's ID, photographed when the shop buys a phone off them.
 *
 * Lebanese shops take the ID for a reason that has nothing to do with
 * bookkeeping: a used handset with no record of who sold it is indistinguishable
 * from a stolen one, and the shop is the one holding it. So this is evidence,
 * and it is treated like evidence — attached to the purchase rather than to a
 * person, kept as it was on the day.
 *
 * It is also somebody's identity document, which is the other half of the job.
 * Anyone who can buy a phone in can attach one; reading one back needs the same
 * permission as revealing a customer's saved password, because that is the same
 * kind of thing to be trusted with. The two are deliberately not the same
 * permission as each other.
 *
 * Kept in SQLite rather than on disk so it rides along with the nightly backup.
 * A photo the shop cannot produce after a restore is not evidence of anything,
 * and `deploy/backup.sh` copies the database and nothing else.
 */
import { db } from '../db.js';

/** What a phone camera or a scanner actually produces. */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

/*
 * Roughly a legible photograph of an ID card and no more. The browser downscales
 * before sending — see client/src/components/IdPhotoField.jsx — so this is the
 * backstop for anything that did not, not the thing shaping the picture. Set
 * against the shop's own backups: at a few phones a week this stays in the tens
 * of megabytes a year, which a SQLite file carries without complaint.
 */
export const MAX_ID_BYTES = 2 * 1024 * 1024;

/**
 * Pull an image out of the `data:` URI a browser produces from a file input.
 *
 * Throws rather than returning null: every failure here is something the person
 * at the counter needs to be told, and each has a different answer.
 */
export function decodeDataUrl(dataUrl) {
  const match = /^data:([\w+/.-]+);base64,(.+)$/s.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('That does not look like an image');

  const [, mime, base64] = match;
  if (!ACCEPTED.has(mime)) {
    throw new Error('The ID must be a photo — JPEG, PNG or WebP');
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new Error('That image is empty');
  if (bytes.length > MAX_ID_BYTES) {
    throw new Error(
      `That photo is ${(bytes.length / 1024 / 1024).toFixed(1)}MB. Keep it under 2MB — a picture of ` +
        'an ID card only has to be readable.',
    );
  }

  return { mime, bytes };
}

/**
 * Attach a photo, replacing whatever was there.
 *
 * Replacing rather than keeping both: the first attempt is usually a blurred
 * one, and a shop left with two photos has to decide which is the real record.
 */
export function setIdPhoto(tradeInId, dataUrl, userId = null) {
  const { mime, bytes } = decodeDataUrl(dataUrl);
  db.prepare(
    `INSERT INTO trade_in_ids (trade_in_id, mime, byte_size, bytes, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(trade_in_id) DO UPDATE SET
       mime = excluded.mime,
       byte_size = excluded.byte_size,
       bytes = excluded.bytes,
       uploaded_by = excluded.uploaded_by,
       created_at = excluded.created_at`,
  ).run(tradeInId, mime, bytes.length, bytes, userId);
  return { mime, byteSize: bytes.length };
}

/** The image itself. Only ever called behind the `secrets` permission. */
export function getIdPhoto(tradeInId) {
  const row = db
    .prepare('SELECT mime, byte_size, bytes FROM trade_in_ids WHERE trade_in_id = ?')
    .get(tradeInId);
  if (!row) return null;
  // node:sqlite hands a BLOB back as a Uint8Array; Express wants a Buffer.
  return { mime: row.mime, byteSize: row.byte_size, bytes: Buffer.from(row.bytes) };
}

/**
 * Whether there is one on file, and who put it there — without the bytes.
 *
 * This is what a list screen needs: a shop checking that its purchases are
 * documented is asking a yes/no question about two hundred rows, and answering
 * it should not mean sending two hundred photographs.
 */
export function idPhotoSummary(tradeInId) {
  return (
    db
      .prepare(
        `SELECT i.mime, i.byte_size, i.created_at, u.name AS uploaded_by_name
         FROM trade_in_ids i LEFT JOIN users u ON u.id = i.uploaded_by
         WHERE i.trade_in_id = ?`,
      )
      .get(tradeInId) || null
  );
}

export function removeIdPhoto(tradeInId) {
  return db.prepare('DELETE FROM trade_in_ids WHERE trade_in_id = ?').run(tradeInId).changes > 0;
}
