async function loadGraph() {
  const types = getSelectedTypes();
  const params = types.length < 5 ? `?types=${types.join(',')}` : '';
  try {
    const res = await fetch(`viz/graph${params}`);
    if (!res.ok) return;
    graphData = await res.json();
    renderGraph();
    updateCounts();
  } catch { /* server not ready or network error, skip */ }
}

function getSelectedTypes() {
  const types = [];
  document.querySelectorAll('#filter-panel input[data-type]').forEach(cb => {
    if (cb.checked) types.push(cb.dataset.type);
  });
  return types;
}

function updateCounts() {
  const nodes = graphData.nodes;
  const grounds = nodes.filter(n => n.type === 'ground');
  const claims  = nodes.filter(n => n.type === 'claim');
  const verifiedGrounds = grounds.filter(n => n.data?.verification === 'verified').length;
  const supportedClaims = claims.filter(n => n.data?.status === 'supported').length;

  const s = graphData.stats;
  for (const t of ['claim', 'ground', 'warrant', 'backing', 'rebuttal']) {
    const el = document.getElementById(`count-${t}`);
    if (el) el.textContent = s[t] || 0;
  }
  document.getElementById('stat-total').textContent = Object.values(s).reduce((a, b) => a + b, 0);

  const gTotal = grounds.length, cTotal = claims.length;
  const gPct = gTotal ? Math.round(verifiedGrounds / gTotal * 100) : 0;
  const cPct = cTotal ? Math.round(supportedClaims / cTotal * 100) : 0;

  document.getElementById('ground-progress-label').textContent = `${verifiedGrounds}/${gTotal} (${gPct}%)`;
  document.getElementById('ground-progress-bar').style.width   = gPct + '%';
  document.getElementById('claim-progress-label').textContent  = `${supportedClaims}/${cTotal} (${cPct}%)`;
  document.getElementById('claim-progress-bar').style.width    = cPct + '%';

  if (typeof updatePhase1Stats === 'function') updatePhase1Stats(graphData.nodes, graphData.stats);
}

let _searchAbort = null;

async function searchNodes(keyword) {
  if (_searchAbort) { _searchAbort.abort(); _searchAbort = null; }

  if (!keyword) {
    g.selectAll('.node-group').transition().duration(300).style('opacity', 1);
    g.selectAll('.node-shape').attr('filter', 'url(#shadow)');
    g.selectAll('.link').transition().duration(300).style('opacity', 1);
    return;
  }

  // ID search: "#3" or bare integer "3"
  const idMatch = keyword.trim().match(/^#?(\d+)$/);
  if (idMatch) {
    const targetId = String(parseInt(idMatch[1], 10));
    g.selectAll('.node-group').transition().duration(300).style('opacity', d => {
      const id = String(currentLayout === 'tree' ? d.data.id : d.id);
      return id === targetId ? 1 : 0.08;
    });
    g.selectAll('.link').transition().duration(300).style('opacity', 0.08);
    if (nodeMap.has(targetId)) selectNodeById(targetId);
    return;
  }

  _searchAbort = new AbortController();
  try {
    const res = await fetch(`viz/search?q=${encodeURIComponent(keyword)}`, { signal: _searchAbort.signal });
    const hits = await res.json();
    _searchAbort = null;
    const matchIds = new Set(hits.map(n => String(n.id)));
    g.selectAll('.node-group').transition().duration(300).style('opacity', d => {
      const id = currentLayout === 'tree' ? d.data.id : d.id;
      return matchIds.has(id) ? 1 : 0.1;
    });
    g.selectAll('.link').transition().duration(300).style('opacity', 0.08);
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
}
