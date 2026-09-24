import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { isMac } from '../platform';

// Classic Levenshtein (edit) distance: the minimum number of single-character
// insertions, deletions, or substitutions to turn `a` into `b`. Only the
// current and previous DP rows are kept (not the full a.length x b.length
// matrix) since nothing else here ever needs to see past that.
function editDistance(a, b) {
  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? prevRow[j - 1]
        : 1 + Math.min(prevRow[j - 1], prevRow[j], row[j - 1]);
    }
    prevRow = row;
  }
  return prevRow[b.length];
}

// How many typos (insertions/deletions/substitutions) a query of this length
// is allowed before a candidate stops counting as a match. Scales with query
// length so a 3-character query isn't swamped by near-arbitrary matches, but
// a longer one still tolerates more than a single slip.
function typoTolerance(queryLength) {
  if (queryLength <= 3) return 0; // too short to safely fuzz: exact substring only
  return Math.floor((queryLength - 1) / 4) + 1;
}

// Lower is a better match; null means no match at all. An exact substring
// match always scores 0 (unchanged from the plain .includes() this replaces,
// so a correctly-typed query is never reordered by the fuzzy fallback below
// it). Failing that, slides a query-length window across the label looking
// for the closest typo'd match: windows one shorter/longer than the query
// are included too, so a single missing or extra character (not just a wrong
// one) still counts as one typo, not a length mismatch that inflates the
// distance past the tolerance.
function fuzzyScore(label, query) {
  const text = label.toLowerCase();
  if (text.includes(query)) return 0;

  const tolerance = typoTolerance(query.length);
  if (tolerance === 0) return null;

  let best = null;
  for (const windowLen of [query.length - 1, query.length, query.length + 1]) {
    if (windowLen <= 0) continue;
    for (let start = 0; start <= text.length - windowLen; start++) {
      const dist = editDistance(query, text.slice(start, start + windowLen));
      if (dist <= tolerance && (best === null || dist < best)) best = dist;
      if (best === 1) break; // won't find better than 1 without an exact match, which is already handled above
    }
  }
  return best;
}

// Global jump-to-anything search: Cmd+K (Mac) / Ctrl+K (elsewhere), or the
// sidebar's Search button, which dispatches 'openCommandPalette' (same window
// CustomEvent pattern App.jsx already uses for farmNameChanged: this needs
// its own trigger from outside the component tree it lives in). Mounted once,
// inside <BrowserRouter>, so it's reachable from every page.
//
// A project or part result navigates to /projects with a query param rather
// than a dedicated route, since Projects.jsx has never had one: it holds
// which project is open as plain component state. See Projects.jsx's own
// useEffect reading `open`/`part` from the URL on mount.
export default function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [printers, setPrinters] = useState(null);
  const [projects, setProjects] = useState(null);
  const [parts, setParts] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    function handleKeyDown(e) {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(v => !v);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    function handleOpenEvent() { setOpen(true); }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('openCommandPalette', handleOpenEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('openCommandPalette', handleOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Focus after the input actually mounts, not before.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Fetched once, lazily, the first time the palette is actually opened: most
  // page visits never use it, so there's no reason to pull the whole
  // printer/project/part list on every load.
  useEffect(() => {
    if (!open || printers !== null) return;
    Promise.all([
      fetch('/api/printers').then(r => r.json()).catch(() => []),
      fetch('/api/projects').then(r => r.json()).catch(() => []),
      fetch('/api/parts').then(r => r.json()).catch(() => []),
    ]).then(([p, proj, prt]) => {
      setPrinters(p);
      setProjects(proj);
      setParts(prt);
    });
  }, [open, printers]);

  const projectNameById = useMemo(() => {
    const m = new Map();
    (projects || []).forEach(p => m.set(p.id, p.name));
    return m;
  }, [projects]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return []; // nothing typed: don't dump the whole fleet, this is a jump-to tool
    const list = [];
    (printers || []).forEach(p => {
      const score = fuzzyScore(p.name, q);
      if (score !== null) list.push({ kind: 'Printer', id: p.id, label: p.name, sub: p.model, score, action: () => navigate(`/printers/${p.id}`) });
    });
    (projects || []).forEach(p => {
      const score = fuzzyScore(p.name, q);
      if (score !== null) list.push({ kind: 'Project', id: p.id, label: p.name, sub: p.status, score, action: () => navigate(`/projects?open=${p.id}`) });
    });
    (parts || []).forEach(p => {
      const score = fuzzyScore(p.name, q);
      if (score !== null) {
        list.push({
          kind: 'Part', id: p.id, label: p.name, sub: projectNameById.get(p.project_id) || '', score,
          action: () => navigate(`/projects?open=${p.project_id}&part=${p.id}`),
        });
      }
    });
    // Best matches first (lower score = closer): an exact substring match
    // (score 0) always outranks a typo'd one, same ordering a plain
    // .includes() filter always gave for the exact-match case, with
    // fuzzy matches now filling in below rather than being absent entirely.
    list.sort((a, b) => a.score - b.score);
    return list.slice(0, 30); // cap: a jump-to tool, not a report
  }, [query, printers, projects, parts, projectNameById, navigate]);

  function choose(result) {
    if (!result) return;
    result.action();
    setOpen(false);
  }

  function handleInputKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[activeIndex]); }
  }

  if (!open) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 2000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
      }}
      onClick={() => setOpen(false)}
    >
      <div
        style={{
          background: '#1e2433', border: '1px solid #334155', borderRadius: 10,
          width: 560, maxWidth: '90vw', maxHeight: '60vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)', overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setActiveIndex(0); }}
          onKeyDown={handleInputKeyDown}
          placeholder="Jump to a printer, project, or part..."
          style={{
            background: 'transparent', border: 'none', borderBottom: '1px solid #334155',
            padding: '14px 16px', fontSize: 15, color: '#e2e8f0', outline: 'none',
          }}
        />
        <div style={{ overflowY: 'auto' }}>
          {printers === null && (
            <div style={{ padding: 16, fontSize: 13, color: '#64748b' }}>Loading...</div>
          )}
          {printers !== null && query.trim() && results.length === 0 && (
            <div style={{ padding: 16, fontSize: 13, color: '#64748b' }}>No matches</div>
          )}
          {printers !== null && !query.trim() && (
            <div style={{ padding: 16, fontSize: 12, color: '#475569' }}>Start typing a name...</div>
          )}
          {results.map((r, i) => (
            <div
              key={`${r.kind}-${r.id}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(r)}
              style={{
                padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                background: i === activeIndex ? '#263244' : 'transparent',
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', width: 52, flexShrink: 0 }}>
                {r.kind}
              </span>
              <span style={{ fontSize: 14, color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.label}
              </span>
              {r.sub && (
                <span style={{ fontSize: 12, color: '#475569', flexShrink: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.sub}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
