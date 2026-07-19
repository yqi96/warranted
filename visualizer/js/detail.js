// Builds inner HTML for the bottom sheet, given raw node data
function buildNodeDetailHtml(data) {
  const tagColor = TYPE_COLORS[data.type] || '#8E8E93';

  let html = `<div id="bs-header">
    <h3>
      <span class="bs-type-tag" style="background:rgba(var(--gold-rgb),0.14);color:${tagColor};border-color:${tagColor}40">${data.type.toUpperCase()}</span>
      #${data.id}
    </h3>
    <button id="bs-close" onclick="clearSelection()">×</button>
  </div>`;

  html += `<div class="bs-body-text">${escapeHtml(data.content)}</div>`;

  // ── Claim ──
  if (data.type === 'claim') {
    const status = data.data?.status || 'proposed';
    const cstate = getClaimCompileState(data.data);
    const cstateLabel = cstate === 'passed' ? 'compiled' : cstate;
    html += `<div class="bs-grid">
      <div class="bs-field">
        <div class="bs-field-label">状态</div>
        <div class="bs-field-value"><span class="status-badge status-${status}">${status}</span></div>
      </div>`;
    if (cstate) {
      html += `<div class="bs-field">
        <div class="bs-field-label">Compile</div>
        <div class="bs-field-value"><span class="status-badge compile-badge-${cstate}">${cstateLabel}</span></div>
      </div>`;
    }
    if (data.data?.qualifier) {
      html += `<div class="bs-field">
        <div class="bs-field-label">Qualifier</div>
        <div class="bs-field-value">${escapeHtml(data.data.qualifier)}</div>
      </div>`;
    }
    html += `</div>`;

    if (cstate) {
      html += `<div class="bs-section">
        <div class="bs-section-title">Compile 详情</div>
        <div class="bs-grid">
          <div class="bs-field">
            <div class="bs-field-label">Verdict</div>
            <div class="bs-field-value" style="font-size:11px">${escapeHtml(data.data?.compile_verdict || '—')}</div>
          </div>
          <div class="bs-field">
            <div class="bs-field-label">时间</div>
            <div class="bs-field-value" style="font-size:11px;color:var(--text-3)">${escapeHtml(data.data?.compile_created_at || '—')}</div>
          </div>
        </div>`;
      if (data.data?.compile_summary) {
        html += `<div style="font-size:11.5px;color:var(--text-2);line-height:1.5;margin-top:6px">${escapeHtml(data.data.compile_summary)}</div>`;
      }
      html += `</div>`;
    }
  }

  // ── Ground ──
  if (data.type === 'ground') {
    const veri = data.data?.verification || 'pending';
    const src  = data.data?.source || '—';
    html += `<div class="bs-grid">
      <div class="bs-field">
        <div class="bs-field-label">验证状态</div>
        <div class="bs-field-value"><span class="veri-badge veri-${veri}">${veri === 'verified' ? '✓ verified' : '⋯ pending'}</span></div>
      </div>
      <div class="bs-field">
        <div class="bs-field-label">来源类型</div>
        <div class="bs-field-value">${escapeHtml(src)}</div>
      </div>
      ${data.data?.ref_claim_id ? `<div class="bs-field">
        <div class="bs-field-label">引用 Claim</div>
        <div class="bs-field-value" style="color:var(--gold);font-weight:500">→ #${data.data.ref_claim_id}</div>
      </div>` : ''}
    </div>`;
  }

  // ── Warrant ──
  if (data.type === 'warrant') {
    html += `<div class="bs-grid">
      <div class="bs-field">
        <div class="bs-field-label">所属 Claim</div>
        <div class="bs-field-value">#${data.data?.claim_id || '—'}</div>
      </div>
      <div class="bs-field">
        <div class="bs-field-label">关联 Grounds</div>
        <div class="bs-field-value">${(data.data?.ground_ids || []).map(i => '#' + i).join(', ') || '—'}</div>
      </div>
    </div>`;
  }

  // ── Backing ──
  if (data.type === 'backing') {
    html += `<div class="bs-grid">
      <div class="bs-field">
        <div class="bs-field-label">所属 Warrant</div>
        <div class="bs-field-value">#${data.data?.warrant_id || '—'}</div>
      </div>
    </div>`;
  }

  // ── Rebuttal ──
  if (data.type === 'rebuttal') {
    html += `<div class="bs-grid">
      <div class="bs-field">
        <div class="bs-field-label">目标节点</div>
        <div class="bs-field-value">#${data.data?.target_id || '—'} <span style="color:var(--text-3)">(${data.data?.target_type || '—'})</span></div>
      </div>
    </div>`;
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
      const sid = currentLayout === 'tree' ? e.source.data.id : (typeof e.source === 'object' ? e.source.id : e.source);
      const tid = currentLayout === 'tree' ? e.target.data.id : (typeof e.target === 'object' ? e.target.id : e.target);
      const isSource = sid === String(data.id);
      const otherId  = isSource ? tid : sid;
      const arrow    = isSource ? '→' : '←';
      const other    = nodeMap.get(otherId);
      const edgeType = currentLayout === 'tree'
        ? inferTreeEdgeType(e.source.data.type, e.target.data.type)
        : e.type;
      html += `<li class="bs-edge-item" onclick="focusNode('${otherId}')">${arrow} ${edgeType} #${otherId}<br><span style="color:var(--text-3);font-size:10px">${escapeHtml(truncate(other?.content || '', 28))}</span></li>`;
    });
    html += `</ul></div>`;
  }

  // ── Attachments ──
  if (data.data?.attachments?.length) {
    html += `<div class="bs-section"><div class="bs-section-title">附件</div><div class="bs-grid">`;
    data.data.attachments.forEach(a => {
      html += `<div class="bs-field"><div class="bs-field-value" style="font-size:11px;color:var(--text-3)">📎 ${escapeHtml(a)}</div></div>`;
    });
    html += `</div></div>`;
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

function focusNode(id) {
  const node = nodeMap.get(id);
  if (!node) return;
  const container = document.getElementById('cy');
  const rect = container.getBoundingClientRect();
  const scale = 1.3;

  if (currentLayout === 'tree') {
    let tx = null, ty = null;
    g.select('.nodes-layer').selectAll('.node-group').each(function(d) {
      if (d.data.id === id) { tx = d.x; ty = d.y; }
    });
    if (tx !== null)
      svg.transition().duration(500).call(zoomBehavior.transform,
        d3.zoomIdentity.translate(rect.width / 2 - tx * scale, rect.height / 2 - ty * scale).scale(scale));
  } else {
    svg.transition().duration(500).call(zoomBehavior.transform,
      d3.zoomIdentity.translate(rect.width / 2 - node.x * scale, rect.height / 2 - node.y * scale).scale(scale));
  }

  selectNodeById(id);
  if (currentLayout === 'tree') {
    g.select('.nodes-layer').selectAll('.node-group').each(function(d) {
      if (d.data.id === id) highlightTreeNeighbors(d);
    });
  } else {
    highlightNeighbors(id);
  }
}
