function panToNode(id) {
  let pos;
  if (currentLayout === 'tree') {
    pos = nodePositionMap.get(id);
  } else {
    const n = nodeMap.get(String(id));
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

function updateSelectionVisuals() {
  if (!g) return;
  g.selectAll('.node-shape').attr('filter', d => {
    const id = currentLayout === 'tree' ? d.data?.id : d.id;
    return selectedNodeIds.has(String(id)) ? 'url(#selectedGlow)' : 'url(#shadow)';
  });
}

async function syncSelectionToServer() {
  try {
    const ids = [...selectedNodeIds].map(id => parseInt(id)).filter(n => !isNaN(n));
    const nodes = ids.map(id => {
      const node = nodeMap.get(String(id)) || nodeMap.get(id);
      if (!node) return null;
      const type = node.type || node.data?.type || '';
      const content = node.content || node.data?.content || '';
      return { id, type, content };
    }).filter(Boolean);
    await fetch('http://localhost:3456/viz/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, nodes }),
    });
  } catch (_) {
    // Server may not be running — ignore silently
  }
}

function selectNodeById(id, additive = false) {
  const sid = String(id);
  if (additive) {
    if (selectedNodeIds.has(sid)) {
      selectedNodeIds.delete(sid);
      if (selectedNodeId === id) {
        selectedNodeId = selectedNodeIds.size > 0 ? [...selectedNodeIds][selectedNodeIds.size - 1] : null;
      }
    } else {
      selectedNodeIds.add(sid);
      selectedNodeId = id;
    }
  } else {
    selectedNodeIds.clear();
    selectedNodeIds.add(sid);
    selectedNodeId = id;
    const node = nodeMap.get(sid) || nodeMap.get(id);
    if (node) openBottomSheet(node);
    panToNode(id);
  }
  updateSelectionVisuals();
  syncSelectionToServer();
}

function clearSelection() {
  selectedNodeId = null;
  selectedNodeIds.clear();
  g.selectAll('.node-group').transition().duration(300).style('opacity', 1);
  g.selectAll('.node-shape').attr('filter', 'url(#shadow)');
  g.selectAll('.link').transition().duration(300).style('opacity', 1);
  closeBottomSheet();
  syncSelectionToServer();
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
