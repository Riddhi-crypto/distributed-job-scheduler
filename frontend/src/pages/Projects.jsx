import { useState } from 'react';
import { api } from '../api.js';
import { Card, Icon, usePoll, Banner, EmptyState, LoadingFull, Field, shortId } from '../components/ui.jsx';

export default function Projects() {
  const { data, loading, error, refresh } = usePoll(() => api.get('/projects'), 8000);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const autoSlug = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function create(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api.post('/projects', { name, slug: slug || autoSlug(name) });
      setName('');
      setSlug('');
      setMsg({ kind: 'ok', text: 'Project created.' });
      refresh();
    } catch (e2) {
      setMsg({ kind: 'err', text: e2.message });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <LoadingFull />;
  const projects = data?.data || [];

  return (
    <div className="grid two-col" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
      <Card title="Projects" icon={Icon.layers} hint={`${projects.length} total`} bodyPad={false}>
        <Banner kind="err">{error?.message}</Banner>
        {projects.length === 0 ? (
          <EmptyState icon={Icon.layers} title="No projects yet">Create your first project to hold queues.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Slug</th><th>Queues</th><th>ID</th></tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td className="mono c-muted">{p.slug}</td>
                    <td className="mono">{p.queue_count}</td>
                    <td className="id-chip">{shortId(p.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="New Project" icon={Icon.plus}>
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <form onSubmit={create} className="spread">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => { setName(e.target.value); if (!slug) setSlug(''); }} placeholder="Billing Pipeline" required />
          </Field>
          <Field label="Slug" hint="lowercase, digits and dashes — auto-filled from the name">
            <input className="input mono" value={slug} onChange={(e) => setSlug(autoSlug(e.target.value))} placeholder={name ? autoSlug(name) : 'billing-pipeline'} />
          </Field>
          <button className="btn primary block" disabled={busy || !name}>Create project</button>
        </form>
      </Card>
    </div>
  );
}
