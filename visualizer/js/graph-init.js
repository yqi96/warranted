function initGraph() {
  svg = d3.select('#graph').append('svg').attr('width', '100%').attr('height', '100%');
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
    .attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
  // Dilate → color cyan → blur for outer ring glow
  selectedGlow.append('feMorphology').attr('in', 'SourceGraphic').attr('operator', 'dilate').attr('radius', 4).attr('result', 'dilated');
  selectedGlow.append('feFlood').attr('flood-color', '#4FDFFF').attr('flood-opacity', 1).attr('result', 'ringColor');
  selectedGlow.append('feComposite').attr('in', 'ringColor').attr('in2', 'dilated').attr('operator', 'in').attr('result', 'ring');
  selectedGlow.append('feGaussianBlur').attr('in', 'ring').attr('stdDeviation', 5).attr('result', 'ringGlow');
  const sgMerge = selectedGlow.append('feMerge');
  sgMerge.append('feMergeNode').attr('in', 'ringGlow');
  sgMerge.append('feMergeNode').attr('in', 'SourceGraphic');

  zoomBehavior = d3.zoom()
    .scaleExtent([0.04, 5])
    .filter(event => {
      if (event.type === 'wheel') return true;
      if (event.type === 'mousedown') {
        const t = event.target;
        const onBackground = t === svg.node() || t.tagName === 'svg' || t.tagName === 'SVG'
          || (!t.closest('.node-group') && !t.closest('.link'));
        if (onBackground) return selectionMode === 'pan';
      }
      return true;
    })
    .on('zoom', e => {
      g.attr('transform', e.transform);
      if (e.sourceEvent) userHasMoved = true;
    });
  svg.call(zoomBehavior);

  // ── Box-select rubber-band ──
  const rubberBand = svg.append('rect').attr('class', 'rubber-band')
    .style('display', 'none');

  let rbStart = null;
  let boxSelectDone = false;  // suppress click event after box-select

  svg.on('mousedown.boxselect', function(event) {
    if (selectionMode !== 'box') return;
    // Only start on background — skip if the click landed on a node or link
    if (event.target.closest && event.target.closest('.node-group')) return;
    if (event.target.closest && event.target.closest('.link')) return;
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
    if (x1 - x0 < 5 && y1 - y0 < 5) { clearSelection(); return; }
    boxSelectDone = true;
    selectNodesInRect(x0, y0, x1, y1);
  });

  svg.on('click', function(e) {
    if (boxSelectDone) { boxSelectDone = false; return; }
    if (e.target === this || e.target.tagName === 'svg' || e.target.tagName === 'SVG') clearSelection();
  });

  g = svg.append('g');
  g.append('g').attr('class', 'links-layer');
  g.append('g').attr('class', 'cross-links-layer');
  g.append('g').attr('class', 'nodes-layer');
  simulation = d3.forceSimulation()
    .force('charge', d3.forceManyBody().strength(-420).distanceMax(500))
    .force('link', d3.forceLink().id(d => d.id).distance(120).strength(0.4))
    .force('collision', d3.forceCollide().radius(d => nodeSize(d) + 14))
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
  closeBottomSheet();
  updateSelectionVisuals();
  syncSelectionToServer();
}

function setSelectionMode(mode) {
  selectionMode = mode;
  document.getElementById('mode-box')?.classList.toggle('active', mode === 'box');
  document.getElementById('mode-pan')?.classList.toggle('active', mode === 'pan');
  const cyEl = document.getElementById('graph');
  if (cyEl) cyEl.style.cursor = mode === 'pan' ? 'grab' : 'default';
}

function drawNodeShape(el, d) {
  const data   = (currentLayout === 'tree') ? d.data : d;
  const fill   = nodeFill(data);
  const stroke = nodeStroke(data);
  const size   = nodeSize(data);

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

    el.append('rect')
      .attr('x', -size * 1.55 + 3).attr('y', -size * 0.68 + 2)
      .attr('width', size * 3.1 - 6).attr('height', size * 0.35)
      .attr('rx', 5).attr('ry', 5)
      .attr('fill', 'rgba(255,255,255,0.07)')
      .attr('pointer-events', 'none');

    if (status === 'supported') {
      el.append('circle').attr('cx', size * 1.35).attr('cy', -size * 0.56).attr('r', 5)
        .attr('fill', '#34C759').attr('stroke', '#090909').attr('stroke-width', 1.5);
      el.append('text').attr('x', size * 1.35).attr('y', -size * 0.56 + 3.5)
        .attr('text-anchor', 'middle').attr('fill', '#090909')
        .attr('font-size', '6.5px').attr('font-weight', '800').text('✓');
    }

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

  } else if (data.type === 'statement' || data.type === 'ground' || data.type === 'backing' || data.type === 'rebuttal') {
    const role = data.data?.primary_role || (data.type !== 'statement' ? data.type : 'ground');
    const s = size;

    if (role === 'rebuttal') {
      el.append('path').attr('class', 'node-shape')
        .attr('d', `M0,${-s} L${s * 1.15},0 L0,${s} L${-s * 1.15},0 Z`)
        .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '4,2').attr('filter', 'url(#shadow)');
      el.append('text').attr('class', 'node-type-label')
        .attr('text-anchor', 'middle').attr('dy', 4).text('R');

    } else if (role === 'backing') {
      el.append('circle').attr('class', 'node-shape')
        .attr('r', s).attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
        .attr('filter', 'url(#shadow)');
      el.append('text').attr('class', 'node-type-label')
        .attr('text-anchor', 'middle').attr('dy', 4).text('B');

    } else {
      const isVerified  = data.data?.verification === 'verified';
      const groundFill  = isVerified ? 'rgba(91,155,213,0.18)' : fill;
      const groundStroke = isVerified ? 'rgba(91,155,213,0.65)' : stroke;
      const sdash       = isVerified ? 'none' : '3,2.5';
      el.append('rect').attr('class', 'node-shape')
        .attr('x', -s).attr('y', -s)
        .attr('width', s * 2).attr('height', s * 2)
        .attr('fill', groundFill).attr('stroke', groundStroke).attr('stroke-width', 1.5)
        .attr('stroke-dasharray', sdash).attr('filter', 'url(#shadow)');
      el.append('text').attr('class', 'node-icon')
        .attr('text-anchor', 'middle').attr('dy', 4).text(isVerified ? '✓' : '·');
    }

  } else if (data.type === 'warrant') {
    const s = size, a = s * 0.87, b = s * 0.50;
    el.append('path').attr('class', 'node-shape')
      .attr('d', `M${-a},${-b} L${a},${-b} L${s},0 L${a},${b} L${-a},${b} L${-s},0 Z`)
      .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
      .attr('filter', 'url(#shadow)');
    el.append('text').attr('class', 'node-type-label').attr('text-anchor', 'middle').attr('dy', 3.5).text('W');

  } else {
    el.append('circle').attr('class', 'node-shape')
      .attr('r', size).attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
      .attr('filter', 'url(#shadow)');
    el.append('text').attr('class', 'node-type-label').attr('text-anchor', 'middle').attr('dy', 3.5).text('?');
  }
}
