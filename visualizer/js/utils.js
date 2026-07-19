function getClaimCompileState(data) {
  if (!data) return null;
  if (data.compile_status === 'passed') return 'passed';
  if (data.compile_status === 'stale')  return 'stale';
  return null;
}

function truncate(s, l) {
  return (!s) ? '' : s.length > l ? s.slice(0, l) + '…' : s;
}

function escapeHtml(s) {
  return (!s) ? '' : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inferTreeEdgeType(sType, tType) {
  if (sType === 'claim'   && tType === 'warrant') return 'supports';
  if (sType === 'warrant' && tType === 'ground')  return 'based_on';
  if (sType === 'ground'  && tType === 'claim')   return 'derives_from';
  if (sType === 'warrant' && tType === 'backing') return 'reinforces';
  if (tType === 'rebuttal') return 'challenges';
  return 'connects';
}

function refreshGraph() { loadGraph(); }

function fitGraph() {
  const container = document.getElementById('cy');
  const rect = container.getBoundingClientRect();

  const nodeData = [];
  g.select('.nodes-layer').selectAll('.node-group').each(function(d) {
    nodeData.push({ x: d.x, y: d.y, type: currentLayout === 'tree' ? d.data.type : d.type });
  });
  if (!nodeData.length) return;

  // Focus initial view on the first ROOT claim tree, top 4 levels
  // Root claims are those at y=0 (they have no parent in tree layout)
  const rootClaims = nodeData.filter(n => n.type === 'claim' && n.y === 0).sort((a, b) => a.x - b.x);
  let focusNodes = nodeData;
  if (rootClaims.length > 0) {
    const firstClaimX = rootClaims[0].x;
    const nextClaimX  = rootClaims[1]?.x ?? Infinity;
    const xBound = isFinite(nextClaimX) ? firstClaimX + (nextClaimX - firstClaimX) / 2 : firstClaimX + 1200;
    // Limit to first tree's x range and first 4 levels of depth (y ≤ 560 at levelH=140)
    const maxDepthY = 560;
    const candidates = nodeData.filter(n => n.x >= firstClaimX - 800 && n.x <= xBound + 60 && n.y <= maxDepthY);
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
  const container = document.getElementById('cy');
  const rect = container.getBoundingClientRect();
  svg.transition().duration(300).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(rect.width / 2, rect.height / 2)
  );
}
