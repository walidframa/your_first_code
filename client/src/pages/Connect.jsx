import { useState } from 'react';
import { Loader2, ShieldCheck, Store, Wifi, WifiOff } from 'lucide-react';
import { normalise, remember } from '../lib/server';
import { Button, Input, cx } from '../components/ui';

/**
 * Where is your shop?
 *
 * The first screen of the phone app, and the only question the web version
 * never has to ask — there the app is served by the shop's own server, so the
 * answer is "here". In an app the pages come from the app itself and the shop
 * is somewhere on the internet, so somebody has to say where, once.
 *
 * It is a screen and not a settings field because of when it happens: a person
 * has just installed this and has never seen it work. Getting it wrong here
 * means an app that opens to an error with no obvious way back, so the address
 * is **checked before it is accepted** — and checked by asking the shop to say
 * its own name, which is the difference between "that is a valid URL" and "that
 * is your shop".
 */
export default function Connect({ onConnected }) {
  const [address, setAddress] = useState('');
  const [state, setState] = useState('asking');
  const [found, setFound] = useState(null);
  const [problem, setProblem] = useState('');

  async function check(e) {
    e.preventDefault();
    const url = normalise(address);
    if (!url) {
      setProblem('That does not look like a web address.');
      setState('failed');
      return;
    }

    setState('checking');
    setProblem('');

    try {
      /*
       * Two questions, and the second is the one that matters.
       *
       * `health` proves something is listening. `branding` proves it is a shop
       * running this app — it answers with the company name, which is what
       * turns a typed address into something the owner can recognise as
       * theirs before they commit to it.
       *
       * Given a short deadline of its own: the default here is minutes, and a
       * phone on a bad signal pointed at a wrong address would sit on a
       * spinner long enough for somebody to decide the app is broken.
       */
      const stop = AbortSignal.timeout(12000);
      const health = await fetch(`${url}/api/health`, { signal: stop });
      if (!health.ok) throw new Error(`answered ${health.status}`);

      let name = '';
      try {
        const res = await fetch(`${url}/api/branding`, { signal: stop });
        if (res.ok) name = (await res.json()).companyName || '';
      } catch {
        // A shop that will not say its name is still a shop. Not fatal.
      }

      setFound({ url, name });
      setState('found');
    } catch (err) {
      /*
       * Named separately because the cures are different, and "could not
       * connect" sends somebody to their router when the problem is a typo.
       */
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      setProblem(
        timedOut
          ? 'Nothing answered at that address. Check the spelling, and that the phone has internet.'
          : String(err?.message || '').includes('answered')
            ? `Something is there, but it is not a Front Desk shop (${err.message}).`
            : 'Could not reach that address. Check the spelling, and that the phone has internet.',
      );
      setState('failed');
    }
  }

  function accept() {
    remember(found.url);
    onConnected?.(found.url);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-slate-900 px-6 pt-[calc(env(safe-area-inset-top)+3rem)] pb-[calc(env(safe-area-inset-bottom)+2rem)] text-white">
      <div className="mx-auto w-full max-w-sm flex-1">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-500">
            <Store size={30} />
          </div>
          <h1 className="text-2xl font-semibold">Connect to your shop</h1>
          <p className="mt-2 text-sm text-slate-400">
            Type the address you use to open the shop in a browser. You only do this once.
          </p>
        </div>

        {state === 'found' ? (
          <div className="rounded-2xl bg-slate-800 p-5 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-500/15 text-brand-400">
              <ShieldCheck size={22} />
            </div>
            <p className="text-sm text-slate-400">Found</p>
            <p className="mt-1 text-lg font-semibold">{found.name || found.url}</p>
            {found.name && <p className="mt-0.5 text-xs text-slate-500">{found.url}</p>}

            <div className="mt-5 space-y-2">
              <Button className="w-full" onClick={accept}>
                Use this shop
              </Button>
              <button
                type="button"
                onClick={() => setState('asking')}
                className="w-full py-2 text-sm text-slate-400"
              >
                Use a different address
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={check} className="space-y-4">
            <div>
              <label htmlFor="server" className="mb-1.5 block text-sm font-medium text-slate-300">
                Shop address
              </label>
              <input
                id="server"
                name="server"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="xtechpos.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                inputMode="url"
                enterKeyHint="go"
                autoComplete="url"
                className={cx(
                  'h-14 w-full rounded-xl bg-slate-800 px-4 text-lg text-white',
                  'ring-1 ring-slate-700 placeholder:text-slate-600',
                  'focus:ring-2 focus:ring-brand-500 focus:outline-none',
                )}
              />
              <p className="mt-2 text-xs text-slate-500">
                Just the address — no need for https:// or a page name.
              </p>
            </div>

            {state === 'failed' && (
              <div
                role="alert"
                className="flex gap-2.5 rounded-xl bg-red-500/10 p-3 text-sm text-red-300"
              >
                <WifiOff size={17} className="mt-0.5 shrink-0" />
                <span>{problem}</span>
              </div>
            )}

            <Button
              type="submit"
              className="h-14 w-full text-base"
              disabled={state === 'checking' || !address.trim()}
            >
              {state === 'checking' ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Looking for it…
                </>
              ) : (
                <>
                  <Wifi size={18} /> Connect
                </>
              )}
            </Button>
          </form>
        )}
      </div>

      <p className="mx-auto max-w-sm text-center text-xs text-slate-600">
        The app keeps nothing of its own. Everything you see comes from your shop, and stays there.
      </p>
    </div>
  );
}
