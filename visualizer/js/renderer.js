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
        if (a.data.type === 'claim' && b.data.type === 'claim') return 1.4;
        if (a.data.type === 'ground' && b.data.type === 'ground' &&
            a.data.data?.ref_claim_id && b.data.data?.ref_claim_id) return 1.6;
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

  function linkStroke(d) {
    const sType = d.source.data.type, tType = d.target.data.type;
    if (sType === 'claim'   && tType === 'warrant') return EDGE_COLORS.supports;
    if (sType === 'warrant' && tType === 'ground')  return EDGE_COLORS.based_on;
    if (sType === 'ground'  && tType === 'claim')   return EDGE_COLORS.reinforces;
    const t = tType;
    return EDGE_COLORS[t === 'backing' ? 'reinforces' : t === 'rebuttal' ? 'challenges' : 'supports']
      || 'rgba(200,180,140,0.30)';
  }
  function linkWidth(d) {
    const sType = d.source.data.type, tType = d.target.data.type;
    if (sType === 'claim') return 3.5;
    if (sType === 'ground' && tType === 'claim') return 2.8;
    return 2.2;
  }
  function linkDash(d) {
    return (d.source.data.type === 'ground' && d.target.data.type === 'claim') ? '9,4' : 'none';
  }
  function linkMarker(d) {
    if (d.source.data.type === 'ground' && d.target.data.type === 'claim') return 'url(#arrow-chain)';
    const t = d.target.data.type;
    const et = t === 'backing' ? 'reinforces' : t === 'rebuttal' ? 'challenges' : t === 'ground' ? 'based_on' : 'supports';
    return `url(#arrow-${et})`;
  }

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
      showEdgeTooltip(event, inferTreeEdgeType(d.source.data.type, d.target.data.type));
    })
    .on('mouseleave', hideTooltip);
  const linkMergeTree = linkEnter.merge(linkSel);
  linkMergeTree.transition().duration(300).style('opacity', 1);
  linkMergeTree.attr('d', d3.linkVertical().x(d => d.x).y(d => d.y));

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
    const s = TYPE_SIZES[d.data.type] || 18;
    const labelY = d.data.type === 'claim' ? s * 0.68 + 14 : s * 1.05 + 13;
    el.append('text').attr('class', 'node-label')
      .attr('text-anchor', 'middle').attr('dy', labelY)
      .text(truncate(d.data.content, 42));
  });

  const nodeMerge = nodeEnter.merge(nodeSel);
  nodeMerge.transition().duration(420).ease(d3.easeQuadOut)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .style('opacity', 1);

  nodeMerge
    .on('click', function(event, d) {
      event.stopPropagation();
      selectNodeById(d.data.id);
      highlightTreeNeighbors(d);
    })
    .on('mouseenter', function(event, d) {
      d3.select(this).select('.node-shape').attr('filter', 'url(#glow)');
      showTooltip(event, d);
    })
    .on('mouseleave', function(event, d) {
      d3.select(this).select('.node-shape').attr('filter', selectedNodeId === d.data.id ? 'url(#selectedGlow)' : 'url(#shadow)');
      hideTooltip();
    });

  setTimeout(() => fitGraph(), 100);
}

// ── 力导向布局 ────────────────────────────────────────────
function renderForceLayout() {
  g.select('.cross-links-layer').selectAll('*').remove();

  const nodes = graphData.nodes.map(n => ({ ...n, id: String(n.id), x: n.x || 0, y: n.y || 0 }));
  const edges = graphData.edges.map(e => ({ ...e, source: String(e.source), target: String(e.target) }));
  nodeMap = new Map(nodes.map(n => [n.id, n]));

  const linkSel = g.select('.links-layer').selectAll('.link').data(edges, d => d.id);
  linkSel.exit().transition().duration(200).style('opacity', 0).remove();

  const linkEnter = linkSel.enter().append('path').attr('class', 'link')
    .attr('stroke', d => EDGE_COLORS[d.type] || 'rgba(200,180,140,0.30)')
    .attr('stroke-width', d => d.type === 'supports' || d.type === 'challenges' ? 3 : 2.2)
    .attr('stroke-dasharray', d => d.type === 'reinforces' || d.type === 'challenges' ? '6,3' : d.type === 'derives_from' ? '2,3' : 'none')
    .attr('marker-end', d => `url(#arrow-${d.type})`)
    .style('opacity', 0);

  linkEnter.transition().duration(420).ease(d3.easeQuadOut).style('opacity', 1);
  linkEnter
    .on('mouseenter', function(event, d) { showEdgeTooltip(event, d.type || 'connects'); })
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
    const s = TYPE_SIZES[d.type] || 18;
    el.append('text').attr('class', 'node-label').attr('text-anchor', 'middle')
      .attr('dy', s + 15).text(truncate(d.content, 30));
  });

  const nodeMerge = nodeEnter.merge(nodeSel);
  nodeMerge.transition().duration(300).style('opacity', 1);
  nodeMerge
    .on('click', function(event, d) {
      event.stopPropagation();
      selectNodeById(d.id);
      highlightNeighbors(d.id);
    })
    .on('mouseenter', function(event, d) {
      d3.select(this).select('.node-shape').attr('filter', 'url(#glow)');
      showTooltip(event, d);
    })
    .on('mouseleave', function(event, d) {
      d3.select(this).select('.node-shape').attr('filter', selectedNodeId === d.id ? 'url(#selectedGlow)' : 'url(#shadow)');
      hideTooltip();
    })
    .call(d3.drag().on('start', dragStarted).on('drag', dragged).on('end', dragEnded));

  simulation.nodes(nodes);
  simulation.force('link').links(edges);
  simulation.alpha(0.8).restart();
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
