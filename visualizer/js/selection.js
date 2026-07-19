function panToNode(id) {
  let pos;
  if (currentLayout === 'tree') {
    pos = nodePositionMap.get(id);
  } else {
    const n = nodeMap.get(id);
    if (n?.x != null) pos = { x: n.x, y: n.y };
  }
  if (!pos) return;
  const rect = svg.node().getBoundingClientRect();
  const k = d3.zoomTransform(svg.node()).k;
  svg.transition().duration(500).ease(d3.easeCubicOut).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(rect.width / 2 - pos.x * k, rect.height / 2 - pos.y * k).scale(k)
  );
}

function selectNodeById(id) {
  selectedNodeId = id;
  const node = nodeMap.get(id);
  if (node) openBottomSheet(node);
  g.selectAll('.node-shape').attr('filter', d => {
    const nid = currentLayout === 'tree' ? d.data?.id : d.id;
    return nid === id ? 'url(#selectedGlow)' : 'url(#shadow)';
  });
  panToNode(id);
}

function clearSelection() {
  selectedNodeId = null;
  g.selectAll('.node-group').transition().duration(300).style('opacity', 1);
  g.selectAll('.node-shape').attr('filter', 'url(#shadow)');
  g.selectAll('.link').transition().duration(300).style('opacity', 1);
  closeBottomSheet();
}

function highlightTreeNeighbors(hierarchyNode) {
  const id = hierarchyNode.data.id;
  const connected = new Set([id]);
  if (hierarchyNode.parent) connected.add(hierarchyNode.parent.data.id);
  (hierarchyNode.children || []).forEach(c => connected.add(c.data.id));
  if (hierarchyNode.parent) (hierarchyNode.parent.children || []).forEach(c => connected.add(c.data.id));

  if (hierarchyNode.data.type === 'claim') {
    g.selectAll('.node-group').each(function(d) {
      if (d.data.type === 'ground' && String(d.data.data?.ref_claim_id) === id)
        connected.add(d.data.id);
    });
  }

  g.selectAll('.node-group').transition().duration(300)
    .style('opacity', d => connected.has(d.data.id) ? 1 : 0.12);
  g.selectAll('.link').transition().duration(300)
    .style('opacity', d => (connected.has(d.source.data.id) || connected.has(d.target.data.id)) ? 1 : 0.05);
}

function highlightNeighbors(id) {
  const connected = new Set([id]);
  const edges = simulation.force('link').links();
  edges.forEach(e => {
    const s = typeof e.source === 'object' ? e.source.id : e.source;
    const t = typeof e.target === 'object' ? e.target.id : e.target;
    if (s === id) connected.add(t);
    if (t === id) connected.add(s);
  });
  g.selectAll('.node-group').transition().duration(300)
    .style('opacity', d => connected.has(d.id) ? 1 : 0.12);
  g.selectAll('.link').transition().duration(300).style('opacity', d => {
    const s = typeof d.source === 'object' ? d.source.id : d.source;
    const t = typeof d.target === 'object' ? d.target.id : d.target;
    return (s === id || t === id) ? 1 : 0.05;
  });
}
