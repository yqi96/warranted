function initGraph() {
  svg = d3.select('#graph').append('svg').attr('width', '100%').attr('height', '100%');
  const defs = svg.append('defs');

  // ── Arrow markers — 三种槽位边各一个 ──
  Object.entries(EDGE_COLORS).forEach(([type, color]) => {
    defs.append('marker').attr('id', `arrow-${type}`)
      .attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4Z').attr('fill', color);
  });

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

/**
 * 画一条命题。
 *
 * 三层编码，各管一件事，互不代偿：
 *   颜色 / 虚实 / 大小 —— qualifier 落在哪一档
 *   形状             —— 它靠什么站着(证据命题 / 附件 / 什么都没有)
 *   角标             —— 有没有未处理的警告与 finding
 *
 * 角标是**提示不是拒绝**(design.md §2.5)：它标出该看一眼的地方，不表示这条命题
 * 有问题。dismiss 过的不再计入 pending，于是标记自己会消失——但底层事实再变时
 * 会复燃，这正是不把它画成"一次性徽章"的原因。
 */
function drawNodeShape(el, d) {
  const data   = (currentLayout === 'tree') ? d.data : d;
  const fill   = nodeFill(data);
  const stroke = nodeStroke(data);
  const dash   = nodeDash(data);
  const s      = nodeSize(data);
  const struct = nodeStructure(data);

  if (struct === 'inference') {
    // 圆角矩形：推出来的——它的证据槽里有别的命题。
    el.append('rect').attr('class', 'node-shape')
      .attr('x', -s * 1.5).attr('y', -s * 0.66)
      .attr('width', s * 3).attr('height', s * 1.32)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.6)
      .attr('stroke-dasharray', dash).attr('filter', 'url(#shadow)');

    el.append('rect')
      .attr('x', -s * 1.5 + 3).attr('y', -s * 0.66 + 2)
      .attr('width', s * 3 - 6).attr('height', s * 0.34)
      .attr('rx', 5).attr('ry', 5)
      .attr('fill', 'rgba(255,255,255,0.06)')
      .attr('pointer-events', 'none');

  } else if (struct === 'sourced') {
    // 方块：靠附件站着。
    el.append('rect').attr('class', 'node-shape')
      .attr('x', -s).attr('y', -s)
      .attr('width', s * 2).attr('height', s * 2)
      .attr('rx', 3).attr('ry', 3)
      .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
      .attr('stroke-dasharray', dash).attr('filter', 'url(#shadow)');

  } else {
    // 圆：证据槽是空的。
    el.append('circle').attr('class', 'node-shape')
      .attr('r', s * 0.9)
      .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.5)
      .attr('stroke-dasharray', dash).attr('filter', 'url(#shadow)');
  }

  const halfW = struct === 'inference' ? s * 1.5 : s;
  const halfH = struct === 'inference' ? s * 0.66 : s;

  // id 落在节点中央——一条命题没有"类型"可显示了，能一眼对上的只有编号。
  el.append('text').attr('class', 'node-id-label')
    .attr('text-anchor', 'middle').attr('dy', 3.5)
    .attr('fill', nodeColor(data))
    .text('#' + data.id);

  // 已展开过的引用：画一圈虚边，表示"完整子树在别处"。
  if (data.isRef) {
    el.append('text').attr('class', 'node-icon')
      .attr('x', halfW - 4).attr('y', halfH - 3)
      .attr('text-anchor', 'end')
      .attr('font-size', '8px').attr('fill', 'rgba(255,255,255,0.35)')
      .text('↗');
  }

  // ── 角标 ──
  const pendingW = data.warnings?.pending || 0;
  const pendingF = data.findings?.pending || 0;

  if (pendingW > 0) {
    el.append('circle')
      .attr('cx', -halfW + 2).attr('cy', -halfH + 1).attr('r', 5.5)
      .attr('fill', '#FF9500').attr('stroke', '#090909').attr('stroke-width', 1.5);
    el.append('text')
      .attr('x', -halfW + 2).attr('y', -halfH + 4.5)
      .attr('text-anchor', 'middle').attr('fill', '#090909')
      .attr('font-size', '7px').attr('font-weight', '800')
      .text(pendingW > 9 ? '9+' : String(pendingW));
  }

  if (pendingF > 0) {
    el.append('circle')
      .attr('cx', halfW - 2).attr('cy', -halfH + 1).attr('r', 5.5)
      .attr('fill', '#E05A4A').attr('stroke', '#090909').attr('stroke-width', 1.5);
    el.append('text')
      .attr('x', halfW - 2).attr('y', -halfH + 4.5)
      .attr('text-anchor', 'middle').attr('fill', '#090909')
      .attr('font-size', '7px').attr('font-weight', '800')
      .text(pendingF > 9 ? '9+' : String(pendingF));
  }

  // 档位缩写放在底边外侧，不与内容标签抢位置。
  el.append('text').attr('class', 'node-band-label')
    .attr('text-anchor', 'middle').attr('dy', halfH + 9)
    .attr('font-size', '7.5px').attr('letter-spacing', '0.08em')
    .attr('fill', nodeColor(data)).attr('opacity', 0.72)
    .text(nodeBandLabel(data));
}

