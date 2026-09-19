import { useEffect, useState } from 'react';
import api from '../api';

/**
 * Ask, as the name is typed, whether this customer or supplier already exists.
 *
 * The server refuses a duplicate at the button, but the moment to say so is
 * while the name is still being typed — before the phone and the address
 * have been filled in for somebody who was already on the books.
 */
export default function useDuplicateParty(partyType, { name, phone, exceptId = null, enabled = true }) {
  const [duplicate, setDuplicate] = useState(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!enabled || !String(name || '').trim()) {
      setDuplicate(null);
      setMessage('');
      return undefined;
    }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/${partyType}s/duplicate`, {
          params: { name, phone: phone || undefined, exceptId: exceptId || undefined },
        });
        if (!live) return;
        setDuplicate(res.data.duplicate || null);
        setMessage(res.data.message || '');
      } catch {
        if (live) {
          setDuplicate(null);
          setMessage('');
        }
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [partyType, name, phone, exceptId, enabled]);

  return { duplicate, message };
}
