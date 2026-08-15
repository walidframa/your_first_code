import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Modal, ModalActions } from './ui';

/**
 * Asking before anything that cannot be taken back.
 *
 * Cancelling, refunding and deleting all move money or lose a record, and all
 * three used to happen on one press. On a counter tablet, where the button
 * somebody meant is a centimetre from the one they hit, that is a refund issued
 * by a sleeve.
 *
 * `confirm()` returns a promise that resolves true or false, so the calling
 * code reads in the order the thing actually happens:
 *
 *     if (!(await confirm({ ... }))) return;
 *     await api.post(...)
 *
 * rather than being turned inside out into callbacks. The dialog is deliberately
 * plain: what will happen, what it cannot undo, and two buttons whose words say
 * which is which — never "OK" and "Cancel" on a question about cancelling
 * something, where "Cancel" is ambiguous in the worst possible place.
 */
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const settle = useRef(null);

  const confirm = useCallback(
    ({ title, body = null, confirmLabel = 'Yes, do it', cancelLabel = 'Keep it', tone = 'danger' }) =>
      new Promise((resolve) => {
        settle.current = resolve;
        setRequest({ title, body, confirmLabel, cancelLabel, tone });
      }),
    [],
  );

  const answer = useCallback((agreed) => {
    setRequest(null);
    // Guarded: closing the dialog by any route settles it exactly once, and a
    // caller left awaiting a promise that never resolves is a screen that has
    // quietly stopped working.
    const resolve = settle.current;
    settle.current = null;
    resolve?.(agreed);
  }, []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}

      {request && (
        <Modal open onClose={() => answer(false)} size="sm" title={request.title}>
          <div className="flex gap-3">
            <span
              className={
                request.tone === 'danger'
                  ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600'
                  : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600'
              }
            >
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 text-sm text-slate-600">
              {request.body || 'This cannot be undone.'}
            </div>
          </div>

          <ModalActions>
            {/*
              * The safe one first and focused, because a dialog that appears
              * under somebody's finger should not have the destructive button
              * where the last press landed.
              */}
            <Button variant="secondary" className="flex-1" onClick={() => answer(false)} autoFocus>
              {request.cancelLabel}
            </Button>
            <Button
              variant={request.tone === 'danger' ? 'danger' : 'primary'}
              className="flex-1"
              onClick={() => answer(true)}
            >
              {request.confirmLabel}
            </Button>
          </ModalActions>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx.confirm;
}
