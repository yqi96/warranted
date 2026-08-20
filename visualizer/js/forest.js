// 把命题与槽位边转成 d3.hierarchy 能吃的森林。
//
// 新本体没有节点类型，所以树的层次不再是 claim→warrant→ground 那种固定三级，
// 而是"谁引用谁"：根是没有任何命题引用的那些(顶层结论)，孩子是它三个槽位里
// 指向的命题——证据、晋升后的理由、反驳。
//
// 图是多根 DAG 而不是树：同一条命题可以坐在多个证据槽里。d3.hierarchy 不接受
// DAG，所以一条命题只在第一次被访问到的地方展开，之后再出现就画成收起的引用
// 节点(`isRef`)。这不是近似——它标出了"这条在别处已经展开过"，正是读图时想知道的。
function buildForest(nodes, edges) {
  const nodeById = new Map(nodes.map(n => [String(n.id), n]));

  const childrenOf = new Map(nodes.map(n => [String(n.id), []]));
  const cited = new Set();   // 被别的命题引用过 → 不是根

  for (const e of edges) {
    const src = String(e.source), tgt = String(e.target);
    if (!childrenOf.has(tgt) || !nodeById.has(src)) continue;
    childrenOf.get(tgt).push({ id: src, edgeType: e.type });
    cited.add(src);
  }

  const allIds = nodes.map(n => String(n.id));
  const rootIds = allIds.filter(id => !cited.has(id));
  // 全图成环时没有根。取 id 最小的一条当入口，总比什么都不画好。
  const finalRoots = rootIds.length ? rootIds : (allIds.length ? [allIds[0]] : []);

  const expanded = new Set();

  function build(id, edgeType, depth) {
    const n = nodeById.get(id);
    if (!n) return null;

    const h = {
      id,
      edgeType: edgeType || null,
      content: n.content,
      qualifier: n.qualifier,
      warrant: n.warrant,
      attachments: n.attachments || [],
      evidence: n.evidence || [],
      rebuttals: n.rebuttals || [],
      warnings: n.warnings || { pending: 0, acknowledged: 0, codes: [] },
      findings: n.findings || { pending: 0, acknowledged: 0 },
      created_at: n.created_at,
      updated_at: n.updated_at,
      isRef: false,
    };

    if (expanded.has(id)) { h.isRef = true; return h; }
    expanded.add(id);

    // 深度上限防的是自引用环：DB 层刻意不加防环 CHECK(循环论证归审查器管，
    // 不归约束管)，所以环真的会出现在图里，渲染层必须自己扛住。
    if (depth > 24) { h.isRef = true; return h; }

    const kids = (childrenOf.get(id) || [])
      .map(c => build(c.id, c.edgeType, depth + 1))
      .filter(Boolean);
    if (kids.length) h.children = kids;
    return h;
  }

  const forests = finalRoots.map(id => build(id, null, 0)).filter(Boolean);

  // 环里的命题一个根都够不到时，会整片缺席。补成各自的根，别静默丢。
  for (const id of allIds) {
    if (!expanded.has(id)) {
      const h = build(id, null, 0);
      if (h) forests.push(h);
    }
  }

  return { forests, crossLinks: [] };
}
