const ttEl      = document.getElementById('tooltip');
const ttType    = document.getElementById('tt-type');
const ttContent = document.getElementById('tt-content');
const ttMeta    = document.getElementById('tt-meta');
let ttTimeout;

function showTooltip(event, nodeData) {
  clearTimeout(ttTimeout);
  const data = (currentLayout === 'tree') ? nodeData.data : nodeData;
  const q = qualifierOf(data);

  ttType.textContent = q.toUpperCase() + '  #' + data.id;
  ttType.style.color = nodeColor(data);
  ttContent.textContent = data.content || '';
  ttMeta.innerHTML = '';

  const chip = (text, cls, css) => {
    const el = document.createElement('span');
    el.className = 'tt-chip' + (cls ? ' ' + cls : '');
    if (css) el.style.cssText = css;
    el.textContent = text;
    ttMeta.appendChild(el);
  };

  const NEUTRAL = 'background:rgba(255,255,255,0.05);color:rgba(240,233,215,0.55);border:1px solid rgba(255,255,255,0.10);border-radius:6px;';

  // 靠什么站着 + 各槽的量。悬停要答的是"这条凭什么"，不是把 content 再抄一遍。
  const STRUCT_LABEL = { inference: '推出的', sourced: '据附件', bare: '无证据' };
  chip(STRUCT_LABEL[nodeStructure(data)], null, NEUTRAL);

  const nEvid = (data.evidence || []).length;
  const nAtt  = (data.attachments || []).length;
  if (nEvid || nAtt) {
    const parts = [];
    if (nEvid) parts.push(`证据 ${nEvid}`);
    if (nAtt)  parts.push(`附件 ${nAtt}`);
    chip(parts.join(' · '), null, NEUTRAL);
  }
  const nReb = (data.rebuttals || []).length;
  if (nReb) chip(`反驳 ${nReb}`, null, 'background:rgba(200,120,88,0.12);color:rgba(230,180,160,0.85);border:1px solid rgba(200,120,88,0.30);border-radius:6px;');

  const w = warrantText(data.warrant);
  chip(w ? '理由 ' + truncate(w, 24) : '理由空', null, NEUTRAL);

  // 待看的量。标红是提示不是拒绝——它出现在这里不表示这条命题有问题。
  const pw = data.warnings?.pending || 0;
  const pf = data.findings?.pending || 0;
  if (pw) chip(`⚑ 警告 ${pw}`, null, 'background:rgba(255,149,0,0.13);color:#FFB44D;border:1px solid rgba(255,149,0,0.32);border-radius:6px;');
  if (pf) chip(`⚑ finding ${pf}`, null, 'background:rgba(224,90,74,0.13);color:#F08A7A;border:1px solid rgba(224,90,74,0.32);border-radius:6px;');

  if (data.isRef) chip('↗ 已在别处展开', null, NEUTRAL);

  positionTooltip(event);
  ttEl.style.display = 'block';
}

function hideTooltip() {
  ttTimeout = setTimeout(() => { ttEl.style.display = 'none'; }, 120);
}

function positionTooltip(event) {
  const pad = 14;
  let x = event.clientX + pad, y = event.clientY + pad;
  const tw = ttEl.offsetWidth || 320, th = ttEl.offsetHeight || 100;
  if (x + tw > window.innerWidth  - 8) x = event.clientX - tw - pad;
  if (y + th > window.innerHeight - 8) y = event.clientY - th - pad;
  ttEl.style.left = Math.max(8, x) + 'px';
  ttEl.style.top  = Math.max(8, y) + 'px';
}

/** 传入的是边的原始种类(evidence / rebuts / warrants)，不是显示名。 */
function showEdgeTooltip(event, edgeType) {
  clearTimeout(ttTimeout);
  ttType.textContent = '── ' + (EDGE_LABELS[edgeType] || String(edgeType).toUpperCase()) + ' ──';
  ttType.style.color = EDGE_COLORS[edgeType] || 'rgba(255,255,255,0.40)';
  ttContent.textContent = '';
  ttMeta.innerHTML = '';
  positionTooltip(event);
  ttEl.style.display = 'block';
}

document.addEventListener('mousemove', e => {
  if (ttEl.style.display === 'block') positionTooltip(e);
});
