import { useEffect, useState } from 'react';
import { Images } from 'lucide-react';
import api from '../api';
import { Button, Card, Input, Select, useToast } from './ui';

/**
 * Where the app looks when it goes to find a picture for a product.
 *
 * Almost nobody needs to open this — the two free libraries work with nothing
 * set up, which is why finding pictures is on by default. It exists for the
 * shop that finds the free libraries have nothing for its stock, which is the
 * usual answer for a phone shop: Commons has a photograph of a Galaxy A54 and
 * nothing whatever of a generic screen protector.
 *
 * The way out is Google's image search on the shop's own key, and it is worth
 * being plain about why that is not simply switched on for everybody. The
 * allowance is charged to whoever owns the key, so it has to be the shop's. And
 * it returns ordinary web images whose copyright belongs to whoever made them,
 * where the two free libraries return work that is licensed to be reused. A
 * shop turning it on is making that decision; the app should not make it for
 * them quietly.
 */
export default function PhotoSourceSettings() {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  /* True when a key is already stored: the key itself never comes back. */
  const [keyOnFile, setKeyOnFile] = useState(false);

  useEffect(() => {
    api.get('/settings').then(({ data }) => {
      setForm({
        photo_source: data.settings.photo_source || 'auto',
        photo_google_cx: data.settings.photo_google_cx || '',
        photo_google_key: '',
      });
      setKeyOnFile(Boolean(data.settings.photo_google_key));
    });
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/settings', {
        photo_source: form.photo_source,
        photo_google_cx: form.photo_google_cx,
        // Left out when it was not retyped, so saving the other fields does not
        // wipe a key the browser was never shown.
        ...(form.photo_google_key ? { photo_google_key: form.photo_google_key } : {}),
      });
      if (form.photo_google_key) setKeyOnFile(true);
      setForm((f) => ({ ...f, photo_google_key: '' }));
      toast('Saved');
    } catch (err) {
      toast(err.response?.data?.error || 'Could not save that', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!form) return null;

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Images size={16} className="text-slate-400" /> Product pictures
      </h2>
      <p className="mt-0.5 mb-4 text-xs text-slate-500">
        Where Products → Find pictures looks. The free libraries need nothing set up here.
      </p>

      <form onSubmit={save} className="space-y-4">
        <Select
          label="Look in"
          name="photo_source"
          value={form.photo_source}
          onChange={(e) => setForm((f) => ({ ...f, photo_source: e.target.value }))}
          hint="Each in turn until one has something, or pin it to one"
        >
          <option value="auto">Each in turn</option>
          <option value="commons">Wikimedia Commons only</option>
          <option value="wikipedia">Wikipedia only</option>
          <option value="openverse">Openverse only</option>
          <option value="google">Google image search only</option>
        </Select>

        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="text-xs text-slate-600">
            <span className="font-medium text-slate-800">Google image search</span> finds the actual
            product where the free libraries find nothing, which for a phone shop is most of a
            catalogue. It needs your own Google key and search-engine id, the searches are charged to
            that key, and what it returns is ordinary web images — their copyright belongs to
            whoever made them, so it is your call whether to use them.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Input
              label="Google API key"
              name="photo_google_key"
              type="password"
              autoComplete="off"
              value={form.photo_google_key}
              onChange={(e) => setForm((f) => ({ ...f, photo_google_key: e.target.value }))}
              placeholder={keyOnFile ? '•••••••• (kept)' : ''}
              hint={keyOnFile ? 'Leave blank to keep the one saved' : 'Never sent back to this screen'}
            />
            <Input
              label="Search engine id"
              name="photo_google_cx"
              autoComplete="off"
              value={form.photo_google_cx}
              onChange={(e) => setForm((f) => ({ ...f, photo_google_cx: e.target.value }))}
              hint="The cx from your custom search engine"
            />
          </div>
        </div>

        <Button type="submit" loading={saving}>
          Save
        </Button>
      </form>
    </Card>
  );
}
