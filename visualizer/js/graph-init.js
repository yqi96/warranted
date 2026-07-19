function initGraph() {
  svg = d3.select('#cy').append('svg').attr('width', '100%').attr('height', '100%');
  const defs = svg.append('defs');

  // ── Arrow markers — semantically typed ──
  Object.entries(EDGE_COLORS).forEach(([type, color]) => {
    defs.append('marker').attr('id', `arrow-${type}`)
      .attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4Z').attr('fill', color);
  });
  // Chain-reference arrow
  defs.append('marker').attr('id', 'arrow-chain')
    .attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4Z').attr('fill', 'rgba(200,164,72,0.40)');

  // ── Subtle drop shadow ──
  const shadow = defs.append('filter').attr('id', 'shadow')
    .attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
  shadow.append('feDropShadow')
    .attr('dx', 0).attr('dy', 2).attr('stdDeviation', 5)
    .attr('flood-color', 'rgba(0,0,0,0.65)').attr('flood-opacity', 1);

  // ── Soft white glow on hover (type-agnostic) ──
  const glow = defs.append('filter').attr('id', 'glow')
    .attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
  glow.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', 6).attr('result', 'blur');
  glow.append('feFlood').attr('flood-color', 'rgba(220,225,240,1)').attr('flood-opacity', 0.30).attr('result', 'clr');
  glow.append('feComposite').attr('in', 'clr').attr('in2', 'blur').attr('operator', 'in').attr('result', 'clrBlur');
  const glowMerge = glow.append('feMerge');
  glowMerge.append('feMergeNode').attr('in', 'clrBlur');
  glowMerge.append('feMergeNode').attr('in', 'SourceGraphic');

  // ── Bright gold selected glow ──
  const selectedGlow = defs.append('filter').attr('id', 'selectedGlow')
    .attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
  selectedGlow.append('feFlood').attr('flood-color', '#C8A448').attr('flood-opacity', 0.55).attr('result', 'color');
  selectedGlow.append('feComposite').attr('in', 'color').attr('in2', 'SourceGraphic').attr('operator', 'in').attr('result', 'coloredSrc');
  selectedGlow.append('feGaussianBlur').attr('in', 'coloredSrc').attr('stdDeviation', 9).attr('result', 'goldGlow');
  const sgMerge = selectedGlow.append('feMerge');
  sgMerge.append('feMergeNode').attr('in', 'goldGlow');
  sgMerge.append('feMergeNode').attr('in', 'SourceGraphic');

  zoomBehavior = d3.zoom()
    .scaleExtent([0.04, 5])
    .filter(event => {
      // Always allow scroll-wheel zoom
      if (event.type === 'wheel') return true;
      // Block pan-drag when starting on bare SVG background (box-select handles that)
      const t = event.target;
      if (event.type === 'mousedown' && (t === svg.node() || t.tagName === 'svg' || t.tagName === 'SVG')) return false;
      return true;
    })
    .on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoomBehavior);

  // ── Box-select rubber-band ──
  const rubberBand = svg.append('rect').attr('class', 'rubber-band')
    .style('display', 'none');

  let rbStart = null;

  svg.on('mousedown.boxselect', function(event) {
    const t = event.target;
    if (t !== this && t.tagName !== 'svg' && t.tagName !== 'SVG') return;
    event.preventDefault();
    const [mx, my] = d3.pointer(event, svg.node());
    rbStart = { x: mx, y: my };
    rubberBand.attr('x', mx).attr('y', my).attr('width', 0).attr('height', 0).style('display', 'block');
  });

  d3.select(window).on('mousemove.boxselect', function(event) {
    if (!rbStart) return;
    const [mx, my] = d3.pointer(event, svg.node());
    const x = Math.min(mx, rbStart.x), y = Math.min(my, rbStart.y);
    const w = Math.abs(mx - rbStart.x), h = Math.abs(my - rbStart.y);
    rubberBand.attr('x', x).attr('y', y).attr('width', w).attr('height', h);
  });

  d3.select(window).on('mouseup.boxselect', function(event) {
    if (!rbStart) return;
    const [mx, my] = d3.pointer(event, svg.node());
    const x0 = Math.min(mx, rbStart.x), y0 = Math.min(my, rbStart.y);
    const x1 = Math.max(mx, rbStart.x), y1 = Math.max(my, rbStart.y);
    rbStart = null;
    rubberBand.style('display', 'none');
    const dist = Math.sqrt((mx - event.clientX) ** 2 + (my - event.clientY) ** 2);
    if (x1 - x0 < 5 && y1 - y0 < 5) { clearSelection(); return; }
    selectNodesInRect(x0, y0, x1, y1);
  });

  svg.on('click', function(e) {
    if (e.target === this || e.target.tagName === 'svg') clearSelection();
  });

  g = svg.append('g');
  g.append('g').attr('class', 'links-layer');
  g.append('g').attr('class', 'cross-links-layer');
  g.append('g').attr('class', 'nodes-layer');
  simulation = d3.forceSimulation()
    .force('charge', d3.forceManyBody().strength(-420).distanceMax(500))
    .force('link', d3.forceLink().id(d => d.id).distance(120).strength(0.4))
    .force('collision', d3.forceCollide().radius(d => (TYPE_SIZES[d.type] || 18) + 14))
    .force('center', d3.forceCenter(0, 0).strength(0.03))
    .on('tick', forceTicked);
  simulation.stop();
}

function selectNodesInRect(x0, y0, x1, y1) {
  const t = d3.zoomTransform(svg.node());
  selectedNodeIds.clear();
  if (currentLayout === 'tree') {
    nodePositionMap.forEach((pos, id) => {
      const sx = t.applyX(pos.x), sy = t.applyY(pos.y);
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) selectedNodeIds.add(String(id));
    });
  } else {
    nodeMap.forEach((node, id) => {
      const sx = t.applyX(node.x || 0), sy = t.applyY(node.y || 0);
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) selectedNodeIds.add(String(id));
    });
  }
  selectedNodeId = selectedNodeIds.size > 0 ? [...selectedNodeIds][0] : null;
  updateSelectionVisuals();
  syncSelectionToServer();
}

function drawNodeShape(el, d) {
  const data   = (currentLayout === 'tree') ? d.data : d;
  const fill   = NODE_FILLS[data.type]   || 'rgba(255,255,255,0.05)';
  const stroke = NODE_STROKES[data.type] || 'rgba(255,255,255,0.18)';
  const size   = TYPE_SIZES[data.type]   || 18;

  if (data.type === 'claim') {
    const status = data.data?.status;
    let sw = 1.5, strokeColor = stroke, dash = 'none';
    if (status === 'supported') { strokeColor = 'rgba(52,199,89,0.70)'; sw = 2; }
    else if (status === 'disputed') { dash = '5,2'; }
    else if (status === 'refuted')  { strokeColor = 'rgba(200,80,60,0.60)'; dash = '5,2'; }

    el.append('rect').attr('class', 'node-shape')
      .attr('x', -size * 1.55).attr('y', -size * 0.68)
      .attr('width', size * 3.1).attr('height', size * 1.36)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', fill).attr('stroke', strokeColor).attr('stroke-width', sw)
      .attr('stroke-dasharray', dash).attr('filter', 'url(#shadow)');

    // Subtle glass sheen
    el.append('rect')
      .attr('x', -size * 1.55 + 3).attr('y', -size * 0.68 + 2)
      .attr('width', size * 3.1 - 6).attr('height', size * 0.35)
      .attr('rx', 5).attr('ry', 5)
      .attr('fill', 'rgba(255,255,255,0.07)')
      .attr('pointer-events', 'none');

    // Status badge (top-right)
    if (status === 'supported') {
      el.append('circle').attr('cx', size * 1.35).attr('cy', -size * 0.56).attr('r', 5)
        .attr('fill', '#34C759').attr('stroke', '#090909').attr('stroke-width', 1.5);
      el.append('text').attr('x', size * 1.35).attr('y', -size * 0.56 + 3.5)
        .attr('text-anchor', 'middle').attr('fill', '#090909')
        .attr('font-size', '6.5px').attr('font-weight', '800').text('✓');
    }

    // Compile badge (top-left)
    const compileState = getClaimCompileState(data.data);
    if (compileState) {
      const badgeFill = compileState === 'passed' ? '#34C759' : '#FF9500';
      el.append('circle')
        .attr('cx', -size * 1.35).attr('cy', -size * 0.56).attr('r', 5)
        .attr('fill', badgeFill).attr('stroke', '#090909').attr('stroke-width', 1.5);
      el.append('text')
        .attr('x', -size * 1.35).attr('y', -size * 0.56 + 3.5)
        .attr('text-anchor', 'middle').attr('fill', '#090909')
        .attr('font-size', '6.5px').attr('font-weight', '800')
        .text(compileState === 'passed' ? '✓' : '!');
    }

    el.append('text').attr('class', 'node-type-label')
      .attr('text-anchor', 'middle').attr('dy', 3.5).text('C#' + data.id);

  } else if (data.type === 'ground') {
    const isVerified = data.data?.verification === 'verified';
    const isChain    = !!data.data?.ref_claim_id;
    const s = size;
    // Verified grounds: brighter fill + solid stroke; unverified: muted dashed
    const groundFill   = isVerified ? 'rgba(91,155,213,0.18)' : fill;
    const groundStroke = isVerified ? 'rgba(91,155,213,0.65)' : stroke;
    const sdash        = (!isVerified && !isChain) ? '3,2.5' : 'none';
    el.append('path').attr('class', 'node-shape')
      .attr('d', `M0,${-s * 1.05} L${s * 1.28},0 L0,${s * 1.05} L${-s * 1.28},0 Z`)
      .attr('fill', groundFill).attr('stroke', groundStroke).attr('stroke-width', 1.5)
      .attr('stroke-dasharray', sdash).attr('filter', 'url(#shadow)');
    const icon = isVerified ? '✓' : isChain ? '→' : '·';
    el.append('text').attr('class', 'node-icon').attr('text-anchor', 'middle').attr('dy', 3.5).text(icon);

  } else if (data.type === 'warrant') {
    const s = size, a = s * 0.87, b = s * 0.50;
    el.append('path').attr('class', 'node-shape')
      .attr('d', `M${-a},${-b} L${a},${-b} L${s},0 L${a},${b} L${-a},${b} L${-s},0 Z`)
      .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
      .attr('filter', 'url(#shadow)');
    el.append('text').attr('class', 'node-type-label').attr('text-anchor', 'middle').attr('dy', 3.5).text('W');

  } else if (data.type === 'rebuttal') {
    const s = size;
    el.append('path').attr('class', 'node-shape')
      .attr('d', `M0,${-s} L${s},${s * 0.7} L${-s},${s * 0.7} Z`)
      .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2').attr('filter', 'url(#shadow)');
    el.append('text').attr('class', 'node-type-label').attr('text-anchor', 'middle').attr('dy', 7).text('R');

  } else {
    // backing
    el.append('circle').attr('class', 'node-shape')
      .attr('r', size).attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
      .attr('filter', 'url(#shadow)');
    el.append('text').attr('class', 'node-type-label').attr('text-anchor', 'middle').attr('dy', 3.5).text('B');
  }
}
