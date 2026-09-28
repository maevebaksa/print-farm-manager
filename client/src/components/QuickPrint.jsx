import { useState } from 'react';
import { useToast } from '../useToast';
import { useAuth } from '../AuthContext';

const inputStyle = {
  background: '#1e2433', border: '1px solid #2d3748', borderRadius: 5, color: '#e2e8f0',
  fontSize: 13, padding: '6px 9px', outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
};

// One-off upload: pick a sliced file, optionally pin it to one printer, print it once.
// POST /api/quick-print (see server/routes/quick-print.js). Hidden when the signed-in
// user's group does not allow it (the server 403s too).
export default function QuickPrint({ onQueued }) {
  const { user } = useAuth();
  const allowed = user?.permissions?.can_quick_print ?? true;
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [printerId, setPrinterId] = useState('any');
  const [printers, setPrinters] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showToast, toastEl] = useToast();

  if (!allowed) return null;

  async function openModal() {
    setOpen(true);
    setError(null);
    const res = await fetch('/api/printers').catch(() => null);
    if (res && res.ok) {
      const rows = await res.json();
      const perms = user?.permissions;
      const ids = perms?.allowed_printer_ids;
      const groups = perms?.allowed_printer_groups;
      setPrinters(rows.filter(p => p.is_active !== 0 && (!ids && !groups
        || (ids || []).includes(p.id) || (groups || []).includes(p.group_name))));
    }
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setFile(null);
    setPrinterId('any');
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (printerId !== 'any') fd.append('printer_id', printerId);
      const res = await fetch('/api/quick-print', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Quick print failed (${res.status})`);
        return;
      }
      showToast(body.pending_approval
        ? `${body.filename} queued, waiting for an operator to approve it`
        : `${body.filename} queued to print once`, body.pending_approval ? 'warning' : 'success');
      setOpen(false);
      setFile(null);
      setPrinterId('any');
      if (onQueued) onQueued();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={openModal}
        title="Upload one sliced file and print it once, without setting up a project"
        style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
      >
        Quick Print
      </button>
      {open && (
        <div
          onClick={close}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
        >
          <form
            onClick={e => e.stopPropagation()}
            onSubmit={submit}
            style={{ background: '#131720', border: '1px solid #2d3748', borderRadius: 10, padding: 20, width: 420, maxWidth: '100%' }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>Quick Print</div>
            <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 14px' }}>
              Prints this file once (one plate). It goes to the queue like any other job and you confirm the result with Set Ready afterwards.
            </p>
            <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Sliced file (.gcode, .bgcode, .3mf)</label>
            <input
              type="file"
              accept=".gcode,.gco,.g,.bgcode,.3mf"
              onChange={e => setFile(e.target.files[0] || null)}
              disabled={busy}
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Printer</label>
            <select value={printerId} onChange={e => setPrinterId(e.target.value)} disabled={busy} style={{ ...inputStyle, cursor: 'pointer', marginBottom: 12 }}>
              <option value="any">Any eligible printer</option>
              {printers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.model})</option>)}
            </select>
            {error && <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 10 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={close} disabled={busy} style={{ background: 'none', border: '1px solid #2d3748', color: '#94a3b8', borderRadius: 5, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !file}
                style={{ background: busy || !file ? '#1e2433' : '#2563eb', color: busy || !file ? '#475569' : '#fff', border: 'none', borderRadius: 5, padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: busy || !file ? 'not-allowed' : 'pointer' }}
              >
                {busy ? 'Uploading…' : 'Print once'}
              </button>
            </div>
          </form>
        </div>
      )}
      {toastEl}
    </>
  );
}
