function renderGraph() {
  currentLayout = document.querySelector('input[name="layout"]:checked').value;
  document.getElementById('empty-state').style.display = graphData.nodes.length === 0 ? 'block' : 'none';
  if (currentLayout === 'tree') { simulation.stop(); renderTreeLayout(); }
  else renderForceLayout();
}

// ── 树形布局 ──────────────────────────────────────────────
function renderTreeLayout() {
  const { forests } = buildForest(graphData.nodes, graphData.edges);
  if (!forests.length) {
    g.selectAll('.links-layer, .cross-links-layer, .nodes-layer').selectAll('*').remove();
    return;
  }

  const nodeSepH = 180, levelH = 140, treeSep = 100;
  let offsetX = 0;
  const allNodes = [], allLinks = [];

  forests.forEach(rootData => {
    const root = d3.hierarchy(rootData);
    const treeLayout = d3.tree()
      .nodeSize([nodeSepH, levelH])
      .separation((a, b) => {
        // 展开的节点比收起的引用占地方，两个都展开时多留一档。
        if (!a.data.isRef && !b.data.isRef) return a.parent === b.parent ? 1.3 : 1.5;
        return a.parent === b.parent ? 1.0 : 1.3;
      });
    treeLayout(root);
    const dx = offsetX;
    root.each(node => { node.x += dx; allNodes.push(node); });
    root.links().forEach(link => allLinks.push(link));
    const xs = allNodes.slice(allNodes.length - root.descendants().length).map(n => n.x);
    const minX = d3.min(xs) || 0, maxX = d3.max(xs) || 0;
    offsetX += (maxX - minX) + treeSep + nodeSepH;
  });

  nodeMap = new Map(allNodes.map(n => [n.data.id, n.data]));
  nodePositionMap = new Map(allNodes.map(n => [n.data.id, { x: n.x, y: n.y }]));

  // 树里 d.source 是父(槽位主人)、d.target 是子(被引用的命题)，边的种类记在子身上
  // ——由 buildForest 从槽位边搬过来的。
  const edgeTypeOf = d => d.target.data.edgeType || 'evidence';

  function linkStroke(d) { return EDGE_COLORS[edgeTypeOf(d)] || 'rgba(200,180,140,0.30)'; }
  function linkWidth(d)  { return edgeTypeOf(d) === 'rebuts' ? 3 : edgeTypeOf(d) === 'warrants' ? 2 : 2.6; }
  function linkDash(d)   { return edgeTypeOf(d) === 'warrants' ? '6,3' : 'none'; }
  function linkMarker(d) { return `url(#arrow-${edgeTypeOf(d)})`; }

  // 画线方向是子 → 父，与边的语义一致：箭头指向用了它的那条命题。
  const treeLink = d3.linkVertical().x(d => d.x).y(d => d.y);
  const linkPath = d => treeLink({ source: d.target, target: d.source });

  // ── Links: fade-in ──
  const linkSel = g.select('.links-layer').selectAll('.link')
    .data(allLinks, d => `${d.source.data.id}-${d.target.data.id}`);
  linkSel.exit().transition().duration(200).style('opacity', 0).remove();

  const linkEnter = linkSel.enter().append('path').attr('class', 'link')
    .attr('stroke', linkStroke).attr('stroke-width', linkWidth)
    .attr('stroke-dasharray', linkDash).attr('marker-end', linkMarker)
    .style('opacity', 0);

  linkEnter.transition().duration(500).delay(d => d.source.depth * 60).ease(d3.easeQuadOut).style('opacity', 1);
  linkEnter
    .on('mouseenter', function(event, d) {
      showEdgeTooltip(event, edgeTypeOf(d));
    })
    .on('mouseleave', hideTooltip);
  const linkMergeTree = linkEnter.merge(linkSel);
  linkMergeTree.transition().duration(300).style('opacity', 1);
  linkMergeTree.attr('d', linkPath);

  // ── Nodes: depth-staggered spring entrance ──
  const nodeSel = g.select('.nodes-layer').selectAll('.node-group')
    .data(allNodes, d => d.data.id);

  nodeSel.exit()
    .transition().duration(180).ease(d3.easeQuadIn)
    .style('opacity', 0)
    .attrTween('transform', function(d) {
      const t = d3.select(this).attr('transform') || `translate(${d.x},${d.y})`;
      return d3.interpolateString(t, `translate(${d.x},${d.y}) scale(0.4)`);
    })
    .remove();

  const nodeEnter = nodeSel.enter().append('g').attr('class', 'node-group')
    .attr('transform', d => `translate(${d.x},${d.y}) scale(0.6)`)
    .style('opacity', 0);

  // Stagger by tree depth so nodes cascade top → bottom
  nodeEnter.transition().duration(480).ease(d3.easeBackOut.overshoot(1.15))
    .delay(d => d.depth * 55)
    .attr('transform', d => `translate(${d.x},${d.y}) scale(1)`)
    .style('opacity', 1);

  nodeEnter.each(function(d) {
    const el = d3.select(this);
    drawNodeShape(el, d);
    const s = nodeSize(d.data);
    // 让开 drawNodeShape 画在 halfH+9 的档位缩写。
    const halfH = nodeStructure(d.data) === 'inference' ? s * 0.66 : s;
    el.append('text').attr('class', 'node-label')
      .attr('text-anchor', 'middle').attr('dy', halfH + 22)
      .text(truncate(d.data.content, 42));
  });

  const nodeMerge = nodeEnter.merge(nodeSel);
  nodeMerge.transition().duration(420).ease(d3.easeQuadOut)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .style('opacity', 1);

  nodeMerge
    .on('click', function(event, d) {
      event.stopPropagation();
      selectNodeById(d.data.id, event.shiftKey);
      if (!event.shiftKey) highlightTreeNeighbors(d);
    })
    .on('dblclick', function(event, d) {
      event.stopPropagation();
      const node = nodeMap.get(String(d.data.id)) || nodeMap.get(d.data.id);
      if (node) openBottomSheet(node);
    })
    .on('mouseenter', function(event, d) {
      if (!selectedNodeIds.has(String(d.data.id)))
        d3.select(this).select('.node-shape').attr('filter', 'url(#glow)');
      showTooltip(event, d);
    })
    .on('mouseleave', function(event, d) {
      d3.select(this).select('.node-shape').attr('filter', selectedNodeIds.has(String(d.data.id)) ? 'url(#selectedGlow)' : 'url(#shadow)');
      hideTooltip();
    });

  setTimeout(() => { if (!userHasMoved) fitGraph(); }, 100);
}

// ── 力导向布局 ────────────────────────────────────────────
function renderForceLayout() {
  g.select('.cross-links-layer').selectAll('*').remove();

  const nodes = graphData.nodes.map(n => {
    const cached = positionCache.get(String(n.id));
    return { ...n, id: String(n.id),
      x: (cached && isFinite(cached.x)) ? cached.x : 0,
      y: (cached && isFinite(cached.y)) ? cached.y : 0 };
  });
  const edges = graphData.edges.map(e => ({ ...e, source: String(e.source), target: String(e.target) }));
  nodeMap = new Map(nodes.map(n => [n.id, n]));

  const linkSel = g.select('.links-layer').selectAll('.link').data(edges, d => d.id);
  linkSel.exit().transition().duration(200).style('opacity', 0).remove();

  const linkEnter = linkSel.enter().append('path').attr('class', 'link')
    .attr('stroke', d => EDGE_COLORS[d.type] || 'rgba(200,180,140,0.30)')
    .attr('stroke-width', d => d.type === 'rebuts' ? 3 : d.type === 'warrants' ? 2 : 2.6)
    .attr('stroke-dasharray', d => d.type === 'warrants' ? '6,3' : 'none')
    .attr('marker-end', d => `url(#arrow-${d.type})`)
    .style('opacity', 0);

  linkEnter.transition().duration(420).ease(d3.easeQuadOut).style('opacity', 1);
  linkEnter
    .on('mouseenter', function(event, d) { showEdgeTooltip(event, d.type || 'evidence'); })
    .on('mouseleave', hideTooltip);
  const linkMerge = linkEnter.merge(linkSel);
  linkMerge.transition().duration(300).style('opacity', 1);

  const nodeSel = g.select('.nodes-layer').selectAll('.node-group').data(nodes, d => d.id);

  nodeSel.exit()
    .transition().duration(180).ease(d3.easeQuadIn)
    .style('opacity', 0)
    .attrTween('transform', function(d) {
      const cur = d3.select(this).attr('transform') || `translate(${d.x || 0},${d.y || 0})`;
      return d3.interpolateString(cur, `translate(${d.x || 0},${d.y || 0}) scale(0.4)`);
    })
    .remove();

  const nodeEnter = nodeSel.enter().append('g').attr('class', 'node-group')
    .attr('transform', d => `translate(${d.x || 0},${d.y || 0}) scale(0.6)`)
    .style('opacity', 0);

  nodeEnter.transition().duration(480).ease(d3.easeBackOut.overshoot(1.15))
    .delay((d, i) => i * 18)
    .attr('transform', d => `translate(${d.x || 0},${d.y || 0}) scale(1)`)
    .style('opacity', 1);

  nodeEnter.each(function(d) {
    const el = d3.select(this);
    drawNodeShape(el, d);
    const s = nodeSize(d);
    const halfH = nodeStructure(d) === 'inference' ? s * 0.66 : s;
    el.append('text').attr('class', 'node-label').attr('text-anchor', 'middle')
      .attr('dy', halfH + 22).text(truncate(d.content, 30));
  });

  const nodeMerge = nodeEnter.merge(nodeSel);
  nodeMerge.transition().duration(300).style('opacity', 1);
  nodeMerge
    .on('click', function(event, d) {
      event.stopPropagation();
      selectNodeById(d.id, event.shiftKey);
      if (!event.shiftKey) highlightNeighbors(d.id);
    })
    .on('dblclick', function(event, d) {
      event.stopPropagation();
      const node = nodeMap.get(String(d.id)) || nodeMap.get(d.id);
      if (node) openBottomSheet(node);
    })
    .on('mouseenter', function(event, d) {
      if (!selectedNodeIds.has(String(d.id)))
        d3.select(this).select('.node-shape').attr('filter', 'url(#glow)');
      showTooltip(event, d);
    })
    .on('mouseleave', function(event, d) {
      d3.select(this).select('.node-shape').attr('filter', selectedNodeIds.has(String(d.id)) ? 'url(#selectedGlow)' : 'url(#shadow)');
      hideTooltip();
    })
    .call(d3.drag().filter(e => !e.shiftKey).on('start', dragStarted).on('drag', dragged).on('end', dragEnded));

  const prevNodeIds = new Set((simulation.nodes() || []).map(n => n.id));
  const newNodeIds  = new Set(nodes.map(n => n.id));
  const nodeSetChanged = prevNodeIds.size !== newNodeIds.size || nodes.some(n => !prevNodeIds.has(n.id));

  const prevEdgeIds = new Set((simulation.force('link').links() || []).map(l => l.id));
  const newEdgeIds  = new Set(edges.map(e => e.id));
  const edgeSetChanged = prevEdgeIds.size !== newEdgeIds.size || edges.some(e => !prevEdgeIds.has(e.id));

  simulation.nodes(nodes);
  simulation.force('link').links(edges);
  if (nodeSetChanged)      simulation.alpha(0.6).restart();
  else if (edgeSetChanged) simulation.alpha(0.15).restart();
  renderForceLayout._linkMerge = linkMerge;
  renderForceLayout._nodeMerge = nodeMerge;
}

function forceTicked() {
  const lm = renderForceLayout._linkMerge;
  const nm = renderForceLayout._nodeMerge;
  if (!lm || !nm) return;
  lm.attr('d', d => {
    const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
    const dr = Math.sqrt(dx * dx + dy * dy) * 1.5;
    return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
  });
  nm.attr('transform', d => `translate(${d.x},${d.y})`);
  nm.each(d => { if (isFinite(d.x) && isFinite(d.y)) positionCache.set(d.id, { x: d.x, y: d.y }); });
}

function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d)   { d.fx = event.x; d.fy = event.y; }
function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}
