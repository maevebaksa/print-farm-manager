import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

const inputStyle = {
  background: '#1e2433', border: '1px solid #2d3748', borderRadius: 5, color: '#e2e8f0',
  fontSize: 13, padding: '6px 9px', outline: 'none', fontFamily: 'inherit',
};

const FLAG_LABELS = [
  ['can_quick_print', 'Can use Quick Print'],
  ['can_set_ready', 'Can Set Ready (confirm finished prints)'],
  ['can_approve', 'Can approve accounts and G-code'],
  ['can_manage_printers', 'Can add, edit, and remove printers'],
  ['can_manage_settings', 'Can change Settings and manage filaments'],
  ['can_manage_others_work', "Can delete or cancel other users' jobs, G-code, parts, and projects"],
  ['can_delete_own_projects', 'Can delete their own projects'],
  ['can_delete_projects', 'Can delete projects'],
  ['can_cancel_own_active_jobs', 'Can cancel their own job that is uploading or printing (for a failing print)'],
  ['can_cancel_active_jobs', 'Can cancel a job that is already uploading or printing'],
  ['requires_approval', 'Uploads need operator approval first'],
];

const EMPTY = {
  name: '', role: 'uploader',
  can_quick_print: true, can_set_ready: false, can_approve: false, can_manage_printers: false,
  can_delete_projects: false, can_cancel_active_jobs: false, can_manage_settings: false, can_manage_others_work: false, can_cancel_own_active_jobs: false, can_delete_own_projects: false, requires_approval: false,
  max_concurrent_plates: '', restrict: false, allowed_printer_ids: [], allowed_printer_groups: [],
};

function toForm(g) {
  return {
    name: g.name, role: g.role,
    can_quick_print: !!g.can_quick_print, can_set_ready: !!g.can_set_ready, can_approve: !!g.can_approve,
    can_manage_printers: !!g.can_manage_printers,
    can_delete_projects: !!g.can_delete_projects, can_cancel_active_jobs: !!g.can_cancel_active_jobs,
    can_manage_settings: !!g.can_manage_settings, can_manage_others_work: !!g.can_manage_others_work, can_cancel_own_active_jobs: !!g.can_cancel_own_active_jobs, can_delete_own_projects: !!g.can_delete_own_projects,
    requires_approval: !!g.requires_approval,
    max_concurrent_plates: g.max_concurrent_plates ?? '',
    restrict: !!(g.allowed_printer_ids || g.allowed_printer_groups),
    allowed_printer_ids: g.allowed_printer_ids || [],
    allowed_printer_groups: g.allowed_printer_groups || [],
  };
}

function summary(g) {
  if (g.role === 'admin') return 'Everything, always';
  const bits = [];
  if (g.can_set_ready) bits.push('Set Ready');
  if (g.can_approve) bits.push('approvals');
  if (g.can_manage_printers) bits.push('printer admin');
  if (g.can_manage_settings) bits.push('can change settings');
  if (g.can_delete_own_projects) bits.push('can delete own projects');
  if (g.can_cancel_own_active_jobs) bits.push('can cancel own active jobs');
  if (g.can_manage_others_work) bits.push("can remove others' work");
  if (g.can_delete_projects) bits.push('can delete projects');
  if (g.can_cancel_active_jobs) bits.push('can cancel active jobs');
  if (!g.can_quick_print) bits.push('no Quick Print');
  if (g.requires_approval) bits.push('uploads need approval');
  if (g.max_concurrent_plates) bits.push(`max ${g.max_concurrent_plates} printers/member at once`);
  const n = (g.allowed_printer_ids || []).length + (g.allowed_printer_groups || []).length;
  bits.push(n ? 'limited printers' : 'all printers');
  return bits.join(', ');
}

// Admin-only section of the Users page: create and edit user groups, each with its
// own permissions and allowed printers (routes/user-groups.js).
export default function UserGroups({ groups, onChanged }) {
  const [editing, setEditing] = useState(null); // 'new' | group id | null
  const [form, setForm] = useState(EMPTY);
  const [printers, setPrinters] = useState([]);
  const [printerGroups, setPrinterGroups] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();

  const loadPrinters = useCallback(async () => {
    const [p, g] = await Promise.all([fetch('/api/printers'), fetch('/api/groups')]).catch(() => []);
    if (p && p.ok) setPrinters((await p.json()).filter(x => x.is_active !== 0));
    if (g && g.ok) setPrinterGroups((await g.json()).map(x => x.name));
  }, []);
  useEffect(() => { loadPrinters(); }, [loadPrinters]);

  function startNew() { setForm(EMPTY); setError(null); setEditing('new'); }
  function startEdit(g) { setForm(toForm(g)); setError(null); setEditing(g.id); }

  function toggleIn(key, value) {
    setForm(f => ({ ...f, [key]: f[key].includes(value) ? f[key].filter(v => v !== value) : [...f[key], value] }));
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        can_quick_print: form.can_quick_print, can_set_ready: form.can_set_ready, can_approve: form.can_approve,
        can_manage_printers: form.can_manage_printers,
        can_delete_projects: form.can_delete_projects, can_cancel_active_jobs: form.can_cancel_active_jobs,
        can_manage_settings: form.can_manage_settings, can_manage_others_work: form.can_manage_others_work, can_cancel_own_active_jobs: form.can_cancel_own_active_jobs, can_delete_own_projects: form.can_delete_own_projects,
        requires_approval: form.requires_approval,
        max_concurrent_plates: form.max_concurrent_plates === '' ? null : Number(form.max_concurrent_plates),
        allowed_printer_ids: form.restrict ? form.allowed_printer_ids : null,
        allowed_printer_groups: form.restrict ? form.allowed_printer_groups : null,
      };
      const current = groups.find(g => g.id === editing);
      if (editing === 'new' || !current?.is_system) { payload.name = form.name.trim(); payload.role = form.role; }
      const res = await fetch(editing === 'new' ? '/api/user-groups' : `/api/user-groups/${editing}`, {
        method: editing === 'new' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || `Save failed (${res.status})`); return; }
      showToast(`Group "${body.name}" saved`, 'success');
      setEditing(null);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function remove(g) {
    const ok = await confirm({
      title: `Delete group "${g.name}"?`,
      message: 'This cannot be undone. A group with members cannot be deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/user-groups/${g.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(`Delete failed: ${body.error || res.status}`, 'error'); return; }
    showToast(`Group "${g.name}" deleted`, 'success');
    onChanged();
  }

  const editingGroup = groups.find(g => g.id === editing);
  const isSystem = !!editingGroup?.is_system;

  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>User groups</div>
        <button onClick={editing === 'new' ? () => setEditing(null) : startNew}
          style={{ background: '#1e2433', color: '#94a3b8', border: '1px solid #2d3748', borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}>
          {editing === 'new' ? 'Cancel' : '+ New group'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
        A group bundles permissions and the printers its members may upload to. Assign users to a group below.
        Managing users, groups, and settings stays with the Admin role.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.map(g => (
          <div key={g.id} style={{ background: '#131720', border: '1px solid #1e2433', borderRadius: 7, padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600 }}>
                {g.name} {g.is_system ? <span style={{ color: '#64748b', fontWeight: 400, fontSize: 12 }}>(built in)</span> : null}
              </div>
              <div style={{ fontSize: 12, color: '#64748b' }}>{g.member_count} member{g.member_count === 1 ? '' : 's'}: {summary(g)}</div>
            </div>
            {g.role !== 'admin' && (
              <button onClick={() => (editing === g.id ? setEditing(null) : startEdit(g))}
                style={{ background: 'none', border: '1px solid #2d3748', color: '#94a3b8', borderRadius: 5, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {editing === g.id ? 'Close' : 'Edit'}
              </button>
            )}
            {!g.is_system && (
              <button onClick={() => remove(g)}
                style={{ background: 'none', border: '1px solid #7f1d1d', color: '#fca5a5', borderRadius: 5, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      {editing !== null && (
        <form onSubmit={save} style={{ background: '#131720', border: '1px solid #2d3748', borderRadius: 8, padding: '16px 18px', marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 14px', marginBottom: 12 }}>
            <input placeholder="Group name" value={form.name} disabled={saving || isSystem} required
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
            <select value={form.role} disabled={saving || isSystem} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="uploader">Based on Uploader</option>
              <option value="operator">Based on Operator</option>
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {FLAG_LABELS.map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#cbd5e1', cursor: 'pointer' }}>
                <input type="checkbox" checked={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))} style={{ accentColor: '#3b82f6' }} />
                {label}
              </label>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#cbd5e1' }}>
              Max printers per member at once
              <input type="number" min={1} placeholder="no limit" value={form.max_concurrent_plates}
                onChange={e => setForm(f => ({ ...f, max_concurrent_plates: e.target.value }))} style={{ ...inputStyle, width: 100 }} />
            </label>
          </div>
          <p style={{ fontSize: 11, color: '#64748b', margin: '-6px 0 12px' }}>
            Caps how many printers one member's own work may occupy at once across all their projects, so one
            person can't tie up the whole farm. Never applies to an admin. Blank means no cap.
          </p>

          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#e2e8f0', fontWeight: 600, cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" checked={form.restrict} onChange={e => setForm(f => ({ ...f, restrict: e.target.checked }))} style={{ accentColor: '#3b82f6' }} />
            Only allow uploads to specific printers
          </label>
          {form.restrict && (
            <div style={{ background: '#0a0f1a', border: '1px solid #1e2433', borderRadius: 6, padding: 10, marginBottom: 12 }}>
              {printerGroups.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>PRINTER GROUPS (includes printers added later)</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                    {printerGroups.map(name => (
                      <label key={name} style={{ fontSize: 13, color: '#cbd5e1', display: 'flex', gap: 5, cursor: 'pointer' }}>
                        <input type="checkbox" checked={form.allowed_printer_groups.includes(name)} onChange={() => toggleIn('allowed_printer_groups', name)} style={{ accentColor: '#3b82f6' }} />
                        {name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>INDIVIDUAL PRINTERS</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', maxHeight: 180, overflowY: 'auto' }}>
                {printers.map(p => (
                  <label key={p.id} style={{ fontSize: 13, color: '#cbd5e1', display: 'flex', gap: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.allowed_printer_ids.includes(p.id)} onChange={() => toggleIn('allowed_printer_ids', p.id)} style={{ accentColor: '#3b82f6' }} />
                    {p.name}
                  </label>
                ))}
              </div>
              {form.allowed_printer_ids.length + form.allowed_printer_groups.length === 0 && (
                <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 8 }}>Nothing ticked means no restriction.</div>
              )}
            </div>
          )}
          {error && <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 10 }}>{error}</div>}
          <button type="submit" disabled={saving}
            style={{ background: saving ? '#1e2433' : '#1e40af', color: saving ? '#475569' : '#fff', border: 'none', borderRadius: 5, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Saving…' : 'Save group'}
          </button>
        </form>
      )}
      {toastEl}
      {confirmModal}
    </div>
  );
}
