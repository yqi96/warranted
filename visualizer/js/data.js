async function loadGraph() {
  try {
    const res = await fetch('viz/graph');
    if (!res.ok) return;
    graphData = await res.json();
    _applyQualifierFilter();
    renderGraph();
    updateCounts();
  } catch { /* server not ready or network error, skip */ }
}

// 过滤按档位走。滤掉一条命题时，连着它的槽位边一起滤——留下的悬空边会画成
// 指向不存在节点的线。
function _applyQualifierFilter() {
  const selected = new Set(getSelectedQualifiers());
  if (!selected.size) return;   // 一个都没勾 = 不过滤，别把图清空
  const visibleNodes = graphData.nodes.filter(n => selected.has(qualifierOf(n)));
  const visibleIds = new Set(visibleNodes.map(n => String(n.id)));
  graphData.nodes = visibleNodes;
  graphData.edges = graphData.edges.filter(e =>
    visibleIds.has(String(e.source)) && visibleIds.has(String(e.target))
  );
}

function getSelectedQualifiers() {
  const qs = [];
  document.querySelectorAll('#filter-panel input[data-qualifier]').forEach(cb => {
    if (cb.checked) qs.push(cb.dataset.qualifier);
  });
  return qs;
}

function updateCounts() {
  // stats 是**全库**按档计数(未经前端过滤)，graphData.nodes 是当前可见的那批。
  // 计数用前者，比例条也用前者——否则勾掉一档会让"已判定率"凭空上涨。
  const s = graphData.stats || {};

  QUALIFIER_ORDER.forEach(q => {
    const el = document.getElementById('count-' + q);
    if (el) el.textContent = s[q] || 0;
  });

  const total = graphData.total || QUALIFIER_ORDER.reduce((a, q) => a + (s[q] || 0), 0);
  const statTotalEl = document.getElementById('stat-total');
  if (statTotalEl) statTotalEl.textContent = total;

  // 已判定：落在正向三档的比例。unestablished 是"还没挣到"，refuted 是挣到了
  // 反面的结论——所以它不算在这条里，它有自己的位置。
  const settled = (s.possibly || 0) + (s.probably || 0) + (s.certainly || 0);
  const sPct = total ? Math.round(settled / total * 100) : 0;

  // 待看：有未处理警告或 finding 的命题数。标红是提示不是拒绝(design.md §2.5)，
  // 这条不是"错误率"，是"还没人看过一眼的量"。
  const flagged = graphData.nodes.filter(hasAttention).length;
  const fPct = total ? Math.round(flagged / total * 100) : 0;

  const sLabel = document.getElementById('settled-progress-label');
  const sBar   = document.getElementById('settled-progress-bar');
  const fLabel = document.getElementById('attention-progress-label');
  const fBar   = document.getElementById('attention-progress-bar');
  if (sLabel) sLabel.textContent = `${settled}/${total} (${sPct}%)`;
  if (sBar)   sBar.style.width   = sPct + '%';
  if (fLabel) fLabel.textContent = `${flagged}/${total} (${fPct}%)`;
  if (fBar)   fBar.style.width   = fPct + '%';

  if (typeof updatePhase1Stats === 'function') updatePhase1Stats(graphData.nodes, s, total);
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
    const matchIds = new Set((hits.rows || []).map(n => String(n.id)));
    g.selectAll('.node-group').transition().duration(300).style('opacity', d => {
      const id = String(currentLayout === 'tree' ? d.data.id : d.id);
      return matchIds.has(id) ? 1 : 0.1;
    });
    g.selectAll('.link').transition().duration(300).style('opacity', 0.08);
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
}
