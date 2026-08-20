// ── Node colour system ──
// 本体只有一种节点，所以颜色不再编码"类型"，而是编码 qualifier 落在哪一档。
// 五档是一条有序标尺(design.md §1.2)，配色也照这条序走：金色一端是挣到的，
// 灰是没挣到，玫瑰是被推翻——中间三档在色温上单调过渡，好让"这条比那条强"
// 不用读文字就看得出来。

const QUALIFIER_ORDER = ['refuted', 'unestablished', 'possibly', 'probably', 'certainly'];

const QUALIFIER_COLORS = {
  certainly:     '#C8A448',   // gold          — 挣满了
  probably:      '#C4B078',   // pale gold
  possibly:      '#A0B8C8',   // silver-blue
  unestablished: '#8E8E93',   // neutral grey  — 还没挣到
  refuted:       '#C87858',   // dusty rose    — 被推翻
};

const QUALIFIER_FILLS = {
  certainly:     'rgba(200,164,72,0.16)',
  probably:      'rgba(196,176,120,0.11)',
  possibly:      'rgba(160,184,200,0.07)',
  unestablished: 'rgba(255,255,255,0.035)',
  refuted:       'rgba(200,120,88,0.09)',
};

const QUALIFIER_STROKES = {
  certainly:     'rgba(200,164,72,0.70)',
  probably:      'rgba(196,176,120,0.52)',
  possibly:      'rgba(160,184,200,0.40)',
  unestablished: 'rgba(255,255,255,0.20)',
  refuted:       'rgba(200,120,88,0.55)',
};

// 尺寸随档位递增：一眼扫过去，承重的东西更大。
const QUALIFIER_SIZES = {
  certainly: 24, probably: 21, possibly: 18,
  unestablished: 15, refuted: 17,
};

// 未成立与被推翻两档画虚线：它们都是"不要直接拿去用"的信号，只是方向相反。
const QUALIFIER_DASH = {
  certainly:     'none',
  probably:      'none',
  possibly:      '6,2.5',
  unestablished: '3,2.5',
  refuted:       '5,2',
};

const QUALIFIER_LABELS = {
  certainly: 'CERT', probably: 'PROB', possibly: 'POSS',
  unestablished: 'UNEST', refuted: 'REF',
};

// ── Edge colours — 三种槽位关系 ──
// 方向统一是"被引用者 → 槽位主人"，所以箭头指向的永远是用了它的那条命题。
const EDGE_COLORS = {
  evidence: 'rgba(200,164,72,0.38)',    // gold        — 支撑
  rebuts:   'rgba(200,130,110,0.48)',   // dusty rose  — 攻击
  warrants: 'rgba(168,160,196,0.34)',   // silver-violet — 晋升后的理由
};

const EDGE_LABELS = {
  evidence: 'EVIDENCE',
  rebuts:   'REBUTS',
  warrants: 'WARRANT',
};

// ── 结构形状 ──
// 形状编码的是本体里真正剩下的那条结构区分：这条命题靠什么站着。
//   inference — 证据槽里有别的命题(它是推出来的)
//   sourced   — 只有附件(它靠文件站着)
//   bare      — 证据槽是空的(它目前什么都没靠)
function nodeStructure(n) {
  if (n.evidence?.length) return 'inference';
  if (n.attachments?.length) return 'sourced';
  return 'bare';
}

function qualifierOf(n) {
  return QUALIFIER_ORDER.includes(n?.qualifier) ? n.qualifier : 'unestablished';
}

// ── Node attribute resolvers ──
function nodeColor(n)      { return QUALIFIER_COLORS[qualifierOf(n)]; }
function nodeFill(n)       { return QUALIFIER_FILLS[qualifierOf(n)]; }
function nodeStroke(n)     { return QUALIFIER_STROKES[qualifierOf(n)]; }
function nodeSize(n)       { return QUALIFIER_SIZES[qualifierOf(n)]; }
function nodeDash(n)       { return QUALIFIER_DASH[qualifierOf(n)]; }
function nodeBandLabel(n)  { return QUALIFIER_LABELS[qualifierOf(n)]; }

/** 正向三档：反驳要有攻击力必须落在这里，判定过的命题也是从这里起算。 */
function isPositive(n) {
  const q = qualifierOf(n);
  return q === 'possibly' || q === 'probably' || q === 'certainly';
}

/** 有没有需要人看一眼的东西。标红是提示不是拒绝(design.md §2.5)。 */
function hasAttention(n) {
  return (n.warnings?.pending || 0) > 0 || (n.findings?.pending || 0) > 0;
}

// ── Global state ──
let svg, g, zoomBehavior, simulation;
let graphData = { nodes: [], edges: [], stats: {}, total: 0 };
let selectedNodeId = null;
let selectedNodeIds = new Set();
let nodeMap = new Map();
let nodePositionMap = new Map();
let currentLayout = 'tree';
let selectionMode = 'pan'; // 'box' | 'pan'
let positionCache = new Map(); // node id → {x, y}, survives re-renders
let userHasMoved = false;      // true after any user-initiated pan/zoom
