async function loadGraph() {
  try {
    const res = await fetch('viz/graph');
    if (!res.ok) return;
    graphData = await res.json();
    _applyRoleFilter();
    renderGraph();
    updateCounts();
  } catch { /* server not ready or network error, skip */ }
}

function _applyRoleFilter() {
  const selected = new Set(getSelectedRoles());
  const visibleNodes = graphData.nodes.filter(n => {
    if (n.type === 'claim')    return selected.has('claim');
    if (n.type === 'warrant')  return selected.has('warrant');
    if (n.type === 'statement') return (n.data?.roles || []).some(r => selected.has(r));
    return true;
  });
  const visibleIds = new Set(visibleNodes.map(n => String(n.id)));
  graphData.nodes = visibleNodes;
  graphData.edges = graphData.edges.filter(e =>
    visibleIds.has(String(e.source)) && visibleIds.has(String(e.target))
  );
}

function getSelectedRoles() {
  const roles = [];
  document.querySelectorAll('#filter-panel input[data-type]').forEach(cb => {
    if (cb.checked) roles.push(cb.dataset.type);
  });
  return roles;
}

function updateCounts() {
  const s  = graphData.stats || {};
  const rs = graphData.roleStats || {};

  const elClaim    = document.getElementById('count-claim');
  const elGround   = document.getElementById('count-ground');
  const elWarrant  = document.getElementById('count-warrant');
  const elBacking  = document.getElementById('count-backing');
  const elRebuttal = document.getElementById('count-rebuttal');
  if (elClaim)    elClaim.textContent    = s.claim   || 0;
  if (elWarrant)  elWarrant.textContent  = s.warrant || 0;
  if (elGround)   elGround.textContent   = rs.ground   || 0;
  if (elBacking)  elBacking.textContent  = rs.backing  || 0;
  if (elRebuttal) elRebuttal.textContent = rs.rebuttal || 0;

  const statTotalEl = document.getElementById('stat-total');
  if (statTotalEl) statTotalEl.textContent = (s.claim || 0) + (s.statement || 0) + (s.warrant || 0);

  const stmtTotal  = s.statement || 0;
  const stmtNodes  = graphData.nodes.filter(n => n.type === 'statement');
  const verified   = stmtNodes.filter(n => n.data?.verification === 'verified').length;
  const gPct = stmtTotal ? Math.round(verified / stmtTotal * 100) : 0;

  const claimNodes     = graphData.nodes.filter(n => n.type === 'claim');
  const supportedCount = claimNodes.filter(n => n.data?.status === 'supported').length;
  const cTotal = s.claim || 0;
  const cPct = cTotal ? Math.round(supportedCount / cTotal * 100) : 0;

  const gLabel = document.getElementById('ground-progress-label');
  const gBar   = document.getElementById('ground-progress-bar');
  const cLabel = document.getElementById('claim-progress-label');
  const cBar   = document.getElementById('claim-progress-bar');
  if (gLabel) gLabel.textContent = `${verified}/${stmtTotal} (${gPct}%)`;
  if (gBar)   gBar.style.width   = gPct + '%';
  if (cLabel) cLabel.textContent = `${supportedCount}/${cTotal} (${cPct}%)`;
  if (cBar)   cBar.style.width   = cPct + '%';

  if (typeof updatePhase1Stats === 'function') updatePhase1Stats(graphData.nodes, s);
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
