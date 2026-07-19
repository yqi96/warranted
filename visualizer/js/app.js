// ── Command window expand / collapse ──
function expandCommandWindow() {
  document.getElementById('command-window').classList.add('expanded');
  document.getElementById('cw-search-input').focus();
}

function collapseCommandWindow() {
  document.getElementById('command-window').classList.remove('expanded');
  document.getElementById('cw-search-input').value = '';
  document.getElementById('search-input').value = '';
  closeBottomSheet();
}

document.getElementById('cw-rest').addEventListener('click', expandCommandWindow);
document.getElementById('cw-close-btn').addEventListener('click', e => { e.stopPropagation(); collapseCommandWindow(); });

document.addEventListener('click', e => {
  const cw = document.getElementById('command-window');
  if (cw.classList.contains('expanded') && !cw.contains(e.target)) collapseCommandWindow();
});

// ── Type toggle buttons (resting bar) ──
document.querySelectorAll('.type-toggle').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const type = btn.dataset.type;
    const isActive = btn.classList.contains('active');
    btn.classList.toggle('active',   !isActive);
    btn.classList.toggle('inactive',  isActive);
    // Sync expanded pills
    const pill = document.querySelector(`.cw-pill[data-type="${type}"]`);
    if (pill) pill.classList.toggle('active', !isActive);
    // Sync hidden checkbox and trigger graph reload
    const cb = document.querySelector(`#filter-panel input[data-type="${type}"]`);
    if (cb) { cb.checked = !isActive; cb.dispatchEvent(new Event('change')); }
  });
});

// ── Filter pills (expanded panel) — mirror type toggles ──
document.querySelectorAll('.cw-pill').forEach(pill => {
  pill.addEventListener('click', e => {
    e.stopPropagation();
    const type = pill.dataset.type;
    const isActive = pill.classList.contains('active');
    pill.classList.toggle('active', !isActive);
    // Sync resting toggle button
    const btn = document.querySelector(`.type-toggle[data-type="${type}"]`);
    if (btn) { btn.classList.toggle('active', !isActive); btn.classList.toggle('inactive', isActive); }
    const cb = document.querySelector(`#filter-panel input[data-type="${type}"]`);
    if (cb) { cb.checked = !isActive; cb.dispatchEvent(new Event('change')); }
  });
});

// ── Layout buttons ──
document.querySelectorAll('.cw-layout-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.cw-layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const layout = btn.dataset.layout;
    const radio = document.querySelector(`#filter-panel input[name="layout"][value="${layout}"]`);
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
    document.getElementById('sb-layout').textContent = btn.textContent;
  });
});

// ── Search input proxy ──
let cwSearchTimeout;
document.getElementById('cw-search-input').addEventListener('input', e => {
  clearTimeout(cwSearchTimeout);
  cwSearchTimeout = setTimeout(() => {
    const hiddenSearch = document.getElementById('search-input');
    if (hiddenSearch) {
      hiddenSearch.value = e.target.value;
      hiddenSearch.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }, 300);
});

// ── Keyboard shortcuts ──
document.querySelectorAll('#filter-panel input[data-type]').forEach(cb =>
  cb.addEventListener('change', () => loadGraph())
);
document.querySelectorAll('input[name="layout"]').forEach(r =>
  r.addEventListener('change', () => renderGraph())
);
let searchTimeout;
document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => searchNodes(e.target.value), 300);
});

document.addEventListener('keydown', e => {
  const cw = document.getElementById('command-window');
  const cwExpanded = cw.classList.contains('expanded');

  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    cwExpanded ? collapseCommandWindow() : expandCommandWindow();
    return;
  }
  if (e.key === '/' && !cwExpanded && !e.metaKey && !e.ctrlKey) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      expandCommandWindow();
      return;
    }
  }
  if (e.key === 'Escape') {
    if (cwExpanded) { collapseCommandWindow(); return; }
    clearSelection();
  }
  if (e.key === 'ArrowDown' && !cwExpanded) returnToPhase1();
  if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) refreshGraph();
  if (e.key === 'f' || e.key === 'F') fitGraph();
});

// ── SSE realtime sync ──
(function setupSSE() {
  const phase1Dot  = document.getElementById('live-dot');
  const phase1Text = document.getElementById('live-text');
  const sbDot      = document.getElementById('sb-live-dot');
  const sbText     = document.getElementById('sb-live-text');

  function setStatus(state) {
    const isOn = state === 'on';
    const dotClass  = isOn ? 'live-dot-on' : 'live-dot-err';
    const textVal   = isOn ? '实时同步' : '重连中…';
    const textColor = isOn ? '#34C759' : '#6E6E73';
    if (phase1Dot)  phase1Dot.className  = dotClass;
    if (phase1Text) { phase1Text.textContent = textVal; phase1Text.style.color = textColor; }
    if (sbDot)      sbDot.className      = 'sb-dot ' + dotClass;
    if (sbText)     sbText.textContent   = textVal;
  }

  const es = new EventSource('viz/events');
  es.onopen  = () => { setStatus('on'); loadGraph(); };
  es.onerror = () => setStatus('err');
  es.addEventListener('data_updated', () => loadGraph());
})();

// ── Startup ──
initGraph();
loadGraph();
