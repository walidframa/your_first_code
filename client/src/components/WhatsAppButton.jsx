import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import api from '../api';
import { cx } from './ui';

/**
 * Send a receipt, an invoice or a repair ticket to the customer's WhatsApp.
 *
 * The server writes the message and hands back a `wa.me` link; this opens it.
 * That means WhatsApp itself does the sending, with the shop's own account and
 * the customer already selected — nothing to sign up for, nothing to pay for,
 * and no way for it to quietly stop working. The cost is that the shopkeeper
 * presses send, so this is a shortcut, not proof of delivery.
 *
 * It is an anchor rather than a button on purpose. Fetching first and then
 * calling window.open lands outside the click that started it, and every
 * browser blocks that as a popup. So the link is fetched when the component
 * appears and the tag is a real link by the time anybody presses it — which
 * also makes middle-click and "copy link" work, as a link should.
 */
export default function WhatsAppButton({
  path,
  label = 'Send on WhatsApp',
  className,
  size = 'md',
}) {
  const [link, setLink] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .get(path)
      .then((res) => live && setLink(res.data))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [path]);

  /*
   * A dead button is worse than none: it looks like something that should work
   * and does not say why. If the message could not be built, there is still the
   * printed slip, so this simply steps out of the way.
   */
  if (failed) return null;

  const ready = Boolean(link?.url);
  const sizes = {
    sm: 'h-8 px-3 text-sm gap-1.5',
    md: 'h-10 px-4 text-sm gap-2',
    lg: 'h-12 px-5 text-base gap-2',
  };

  return (
    <a
      href={ready ? link.url : undefined}
      target="_blank"
      rel="noreferrer"
      aria-disabled={!ready}
      /*
       * Said in the tooltip rather than the label, which has to stay the same
       * width whoever it is going to. "No number on file" is worth knowing
       * before pressing it, because WhatsApp will then ask who to send to.
       */
      title={
        link?.to
          ? `Send to ${link.name ? `${link.name} — ` : ''}+${link.to}`
          : 'No number on file — WhatsApp will ask who to send it to'
      }
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-lg font-medium whitespace-nowrap transition',
        'bg-[#25D366] text-white shadow-sm hover:bg-[#1da851] active:bg-[#178f43]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#25D366]',
        !ready && 'pointer-events-none opacity-50',
        sizes[size],
        className,
      )}
    >
      <MessageCircle size={16} /> {label}
    </a>
  );
}
