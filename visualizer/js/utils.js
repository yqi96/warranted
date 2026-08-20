function truncate(s, l) {
  return (!s) ? '' : s.length > l ? s.slice(0, l) + '…' : s;
}

function escapeHtml(s) {
  return (!s) ? '' : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 理由槽的三种形态渲染成一句话(design.md §1.2)。 */
function warrantText(w) {
  if (!w || w.kind === 'empty') return null;
  if (w.kind === 'inline') return w.text;
  return `→ #${w.node_id}`;
}

function refreshGraph() { positionCache.clear(); userHasMoved = false; loadGraph(); }

function fitGraph() {
  const container = document.getElementById('graph');
  const rect = container.getBoundingClientRect();

  const nodeData = [];
  g.select('.nodes-layer').selectAll('.node-group').each(function(d) {
    nodeData.push({ x: d.x, y: d.y });
  });
  if (!nodeData.length) return;

  // 初始视野落在第一棵树的顶部四层。根在 y=0——树布局里没有父节点的就是根，
  // 也就是没有任何命题引用的那些顶层结论。
  const roots = nodeData.filter(n => n.y === 0).sort((a, b) => a.x - b.x);
  let focusNodes = nodeData;
  if (roots.length > 0) {
    const firstX = roots[0].x;
    const nextX  = roots[1]?.x ?? Infinity;
    const xBound = isFinite(nextX) ? firstX + (nextX - firstX) / 2 : firstX + 1200;
    const maxDepthY = 560;   // levelH=140 → 前 4 层
    const candidates = nodeData.filter(n => n.x >= firstX - 800 && n.x <= xBound + 60 && n.y <= maxDepthY);
    if (candidates.length >= 3) focusNodes = candidates;
  }

  const pad = 70;
  const xs = focusNodes.map(n => n.x);
  const ys = focusNodes.map(n => n.y);
  const minX = d3.min(xs) - pad, maxX = d3.max(xs) + pad;
  const minY = d3.min(ys) - pad, maxY = d3.max(ys) + pad;
  const w = maxX - minX, h = maxY - minY;
  const scale = Math.min(rect.width / w, rect.height / h, 1.5) * 0.82;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  svg.transition().duration(600).ease(d3.easeCubicOut).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(rect.width / 2 - cx * scale, rect.height / 2 - cy * scale).scale(scale)
  );
}

function centerGraph() {
  const container = document.getElementById('graph');
  const rect = container.getBoundingClientRect();
  svg.transition().duration(300).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(rect.width / 2, rect.height / 2)
  );
}
