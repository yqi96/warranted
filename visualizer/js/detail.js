// Builds inner HTML for the bottom sheet, given raw node data
//
// 一条命题只有五个槽(design.md §1.2)，这里就照五个槽铺开：content 在最上、
// qualifier 是它挣到的档、证据/理由/反驳各占一节。没有"类型"可显示了——
// 顶上那枚标签给的是档位。
function buildNodeDetailHtml(data) {
  const q        = qualifierOf(data);
  const tagColor = nodeColor(data);
  const struct   = nodeStructure(data);
  const STRUCT_LABEL = { inference: '推出的', sourced: '据附件', bare: '无证据' };

  let html = `<div id="bs-header">
    <h3>
      <span class="bs-band-tag band-${q}" style="color:${tagColor};border-color:${tagColor}40">${QUALIFIER_LABELS[q]}</span>
      #${data.id}
    </h3>
    <button id="bs-close" onclick="clearSelection()">×</button>
  </div>`;

  html += `<div class="bs-body-text">${escapeHtml(data.content)}</div>`;

  const wText = warrantText(data.warrant);
  html += `<div class="bs-grid">
    <div class="bs-field">
      <div class="bs-field-label">Qualifier</div>
      <div class="bs-field-value"><span class="band-badge band-${q}">${escapeHtml(q)}</span></div>
    </div>
    <div class="bs-field">
      <div class="bs-field-label">结构</div>
      <div class="bs-field-value" style="color:var(--text-2)">${STRUCT_LABEL[struct]}</div>
    </div>
    <div class="bs-field">
      <div class="bs-field-label">理由</div>
      <div class="bs-field-value" style="font-size:11px;color:${wText ? 'var(--text-2)' : 'var(--text-3)'}">${wText ? escapeHtml(wText) : '— 空'}</div>
    </div>
  </div>`;

  // ── 证据槽：附件与命题共用一个槽，只是存储分两张表 ──
  const atts = data.attachments || [];
  const evid = data.evidence || [];
  if (atts.length || evid.length) {
    html += `<div class="bs-section"><div class="bs-section-title">证据</div><div class="bs-grid">`;
    evid.forEach(id => {
      const other = nodeMap.get(String(id));
      html += `<div class="bs-field bs-field-click" onclick="focusNode('${id}')">
        <div class="bs-field-value" style="font-size:11px">#${id}
        <span style="color:var(--text-3)">${escapeHtml(truncate(other?.content || '', 30))}</span></div>
      </div>`;
    });
    atts.forEach(a => {
      html += `<div class="bs-field"><div class="bs-field-value" style="font-size:11px;color:var(--text-3)">📎 ${escapeHtml(a)}</div></div>`;
    });
    html += `</div></div>`;
  }

  // ── 反驳槽 ──
  const rebs = data.rebuttals || [];
  if (rebs.length) {
    html += `<div class="bs-section"><div class="bs-section-title">反驳</div><div class="bs-grid">`;
    rebs.forEach(id => {
      const other = nodeMap.get(String(id));
      html += `<div class="bs-field bs-field-click" onclick="focusNode('${id}')">
        <div class="bs-field-value" style="font-size:11px">#${id}
        <span style="color:var(--text-3)">${escapeHtml(truncate(other?.content || '', 30))}</span></div>
      </div>`;
    });
    html += `</div></div>`;
  }

  // ── Connected edges ──
  let connEdges = [];
  if (currentLayout === 'tree') {
    g.select('.links-layer').selectAll('.link').each(function(d) {
      if (d.source.data.id === String(data.id) || d.target.data.id === String(data.id)) connEdges.push(d);
    });
  } else {
    simulation.force('link').links().forEach(e => {
      const s = typeof e.source === 'object' ? e.source.id : e.source;
      const t = typeof e.target === 'object' ? e.target.id : e.target;
      if (s === String(data.id) || t === String(data.id)) connEdges.push(e);
    });
  }

  if (connEdges.length) {
    html += `<div class="bs-section">
      <div class="bs-section-title">关联边</div>
      <ul class="bs-edge-list">`;
    connEdges.forEach(e => {
      // 树里边的种类记在子节点上；力导向图里边自己带 type。
      const sid = currentLayout === 'tree' ? e.source.data.id : (typeof e.source === 'object' ? e.source.id : e.source);
      const tid = currentLayout === 'tree' ? e.target.data.id : (typeof e.target === 'object' ? e.target.id : e.target);
      const edgeType = currentLayout === 'tree' ? (e.target.data.edgeType || 'evidence') : e.type;
      // 语义方向永远是"被引用者 → 槽位主人"。树里父是主人、子是被引用者，
      // 所以对本节点而言：它是父 = 别人支撑它(←)，它是子 = 它支撑别人(→)。
      const isOwner = currentLayout === 'tree' ? sid === String(data.id) : tid === String(data.id);
      const otherId = currentLayout === 'tree' ? (isOwner ? tid : sid) : (isOwner ? String(e.source.id ?? e.source) : String(e.target.id ?? e.target));
      const arrow   = isOwner ? '←' : '→';
      const other   = nodeMap.get(String(otherId));
      html += `<li class="bs-edge-item" onclick="focusNode('${otherId}')">${arrow} ${EDGE_LABELS[edgeType] || edgeType} #${otherId}<br><span style="color:var(--text-3);font-size:10px">${escapeHtml(truncate(other?.content || '', 28))}</span></li>`;
    });
    html += `</ul></div>`;
  }

  // ── 待看：明细异步补 ──
  // 图上只画"有没有"，具体断在哪要问 /viz/nodes/:id。标红是提示不是拒绝
  // (design.md §2.5)——所以这一节即使有内容也不改上面的任何显示。
  const pendingW = data.warnings?.pending || 0;
  const pendingF = data.findings?.pending || 0;
  const ackW     = data.warnings?.acknowledged || 0;
  const ackF     = data.findings?.acknowledged || 0;
  if (pendingW || pendingF || ackW || ackF) {
    html += `<div class="bs-section">
      <div class="bs-section-title">待看 ${pendingW + pendingF} / 已阅 ${ackW + ackF}</div>
      <div id="bs-attention-${data.id}"><span style="color:var(--text-3);font-size:11px">载入中…</span></div>
    </div>`;
    loadAttentionDetail(data.id);
  }

  // ── Timestamps ──
  html += `<div class="bs-grid" style="margin-top:4px">
    <div class="bs-field">
      <div class="bs-field-label">创建</div>
      <div class="bs-field-value" style="font-size:11px;color:var(--text-3)">${data.created_at || '—'}</div>
    </div>
    <div class="bs-field">
      <div class="bs-field-label">更新</div>
      <div class="bs-field-value" style="font-size:11px;color:var(--text-3)">${data.updated_at || '—'}</div>
    </div>
  </div>`;

  return html;
}

/** 拉单条命题的完整视图，把警告与 finding 的原话填进占位。 */
async function loadAttentionDetail(id) {
  let view;
  try {
    const res = await fetch(`viz/nodes/${id}`);
    if (!res.ok) return;
    view = await res.json();
  } catch { return; }

  const box = document.getElementById(`bs-attention-${id}`);
  if (!box) return;   // 面板已经切走了

  const items = [];
  (view.warnings || []).forEach(w => {
    items.push(`<li class="bs-att-item att-${w.state}">
      <span class="att-code">${escapeHtml(w.code)}</span>
      <span class="att-msg">${escapeHtml(w.message)}</span>
      ${w.dismissal ? `<div class="att-dismissal">已阅：${escapeHtml(w.dismissal.reason)}</div>` : ''}
    </li>`);
  });
  (view.findings || []).forEach(f => {
    // Q1 引的是附件的某处，Q2 引的是某条命题某个槽里的逐字片段。
    const cite = f.question === 'Q1'
      ? `${f.citation?.attachment || ''} @ ${f.citation?.locator || ''}｜${f.citation?.quote || ''}`
      : `#${f.citation?.nodeId} ${f.citation?.slot || ''}｜${f.citation?.quote || ''}`;
    items.push(`<li class="bs-att-item att-${f.state} att-finding">
      <span class="att-code">${escapeHtml(f.question)}·${escapeHtml(f.confidence)}</span>
      <span class="att-msg">${escapeHtml(f.content)}</span>
      ${cite.trim() ? `<div class="att-cite">${escapeHtml(truncate(cite.trim(), 90))}</div>` : ''}
      ${f.dismissal ? `<div class="att-dismissal">已阅：${escapeHtml(f.dismissal.reason)}</div>` : ''}
    </li>`);
  });

  box.innerHTML = items.length
    ? `<ul class="bs-att-list">${items.join('')}</ul>`
    : `<span style="color:var(--text-3);font-size:11px">—</span>`;
}

function focusNode(id) {
  const node = nodeMap.get(String(id));
  if (!node) return;
  const container = document.getElementById('graph');
  const rect = container.getBoundingClientRect();
  const scale = 1.3;

  if (currentLayout === 'tree') {
    let tx = null, ty = null;
    g.select('.nodes-layer').selectAll('.node-group').each(function(d) {
      if (d.data.id === String(id)) { tx = d.x; ty = d.y; }
    });
    if (tx !== null)
      svg.transition().duration(500).call(zoomBehavior.transform,
        d3.zoomIdentity.translate(rect.width / 2 - tx * scale, rect.height / 2 - ty * scale).scale(scale));
  } else {
    svg.transition().duration(500).call(zoomBehavior.transform,
      d3.zoomIdentity.translate(rect.width / 2 - node.x * scale, rect.height / 2 - node.y * scale).scale(scale));
  }

  selectNodeById(String(id));
  if (currentLayout === 'tree') {
    g.select('.nodes-layer').selectAll('.node-group').each(function(d) {
      if (d.data.id === String(id)) highlightTreeNeighbors(d);
    });
  } else {
    highlightNeighbors(String(id));
  }
}
