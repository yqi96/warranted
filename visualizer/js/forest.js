// 将节点和边转换为适合 d3.hierarchy 的树形结构（森林）
function buildForest(nodes, edges) {
  const nodeById = new Map(nodes.map(n => [String(n.id), n]));

  const warrantsByClaim  = new Map(nodes.map(n => [String(n.id), []]));
  const groundsByWarrant = new Map(nodes.map(n => [String(n.id), []]));
  const refClaimByGround = new Map(); // chain ground id → referenced claim id
  const referencedClaims = new Set(); // claims used as chain grounds by other claims
  const extrasOf = new Map(nodes.map(n => [String(n.id), []])); // backing/rebuttal children

  edges.filter(e => e.type === 'supports').forEach(e => {
    const cid = String(e.source), wid = String(e.target);
    if (warrantsByClaim.has(cid)) warrantsByClaim.get(cid).push(wid);
  });

  edges.filter(e => e.type === 'based_on').forEach(e => {
    const gid = String(e.source), wid = String(e.target);
    if (groundsByWarrant.has(wid)) groundsByWarrant.get(wid).push(gid);
  });

  // Chain grounds that are actually wired into a warrant via based_on.
  // Orphaned chain grounds must NOT exclude their referenced claim from roots.
  const activeChainGrounds = new Set(
    edges.filter(e => e.type === 'based_on').map(e => String(e.source))
  );

  edges.filter(e => e.type === 'derives_from').forEach(e => {
    const refCid = String(e.source), gid = String(e.target);
    refClaimByGround.set(gid, refCid);
    if (activeChainGrounds.has(gid)) {
      referencedClaims.add(refCid);
    }
  });

  edges.filter(e => e.type === 'reinforces').forEach(e => {
    const wid = String(e.source), bid = String(e.target);
    if (extrasOf.has(wid)) extrasOf.get(wid).push(bid);
  });

  edges.filter(e => e.type === 'challenges').forEach(e => {
    const tid = String(e.source), rid = String(e.target);
    if (extrasOf.has(tid)) extrasOf.get(tid).push(rid);
  });

  const allClaimIds = nodes.filter(n => n.type === 'claim').map(n => String(n.id));
  const rootIds  = allClaimIds.filter(c => !referencedClaims.has(c));
  const finalRoots = rootIds.length ? rootIds : (allClaimIds.length ? [allClaimIds[0]] : []);

  const visitedClaims = new Set();

  function buildLeaf(nodeId) {
    const n = nodeById.get(nodeId);
    if (!n) return null;
    const h = { id: nodeId, type: n.type, content: n.content, data: n.data, created_at: n.created_at, updated_at: n.updated_at };
    const kids = (extrasOf.get(nodeId) || []).map(buildLeaf).filter(Boolean);
    if (kids.length) h.children = kids;
    return h;
  }

  function buildClaimNode(claimId) {
    if (visitedClaims.has(claimId)) return null;
    visitedClaims.add(claimId);
    const cn = nodeById.get(claimId);
    if (!cn) return null;
    const h = { id: claimId, type: 'claim', content: cn.content, data: cn.data, created_at: cn.created_at, updated_at: cn.updated_at, children: [] };

    for (const kid of extrasOf.get(claimId) || []) {
      const kh = buildLeaf(kid);
      if (kh) h.children.push(kh);
    }

    for (const wid of warrantsByClaim.get(claimId) || []) {
      const wn = nodeById.get(wid);
      if (!wn) continue;
      const wh = { id: wid, type: 'warrant', content: wn.content, data: wn.data, created_at: wn.created_at, updated_at: wn.updated_at, children: [] };

      for (const kid of extrasOf.get(wid) || []) {
        const kh = buildLeaf(kid);
        if (kh) wh.children.push(kh);
      }

      for (const gid of groundsByWarrant.get(wid) || []) {
        const gn = nodeById.get(gid);
        if (!gn) continue;
        const gh = { id: gid, type: 'ground', content: gn.content, data: gn.data, created_at: gn.created_at, updated_at: gn.updated_at, children: [] };

        const refCid = refClaimByGround.get(gid);
        if (refCid) {
          const sub = buildClaimNode(refCid);
          if (sub) gh.children.push(sub);
        }

        if (!gh.children.length) delete gh.children;
        wh.children.push(gh);
      }

      if (!wh.children.length) delete wh.children;
      h.children.push(wh);
    }

    if (!h.children.length) delete h.children;
    return h;
  }

  const forests = finalRoots.map(buildClaimNode).filter(Boolean);

  // 将未挂入树中的孤立节点作为单节点根追加
  const inTree = new Set();
  function collectIds(h) { inTree.add(h.id); (h.children || []).forEach(collectIds); }
  forests.forEach(collectIds);
  nodes.forEach(n => {
    if (!inTree.has(String(n.id)))
      forests.push({ id: String(n.id), type: n.type, content: n.content, data: n.data, created_at: n.created_at, updated_at: n.updated_at });
  });

  return { forests, crossLinks: [] };
}
