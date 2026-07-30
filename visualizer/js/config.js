// ── Node color system ──
// Claims are the golden protagonist. All other types use desaturated, near-neutral
// tones so the claim hierarchy pops visually. Shape distinguishes type, not hue.

const TYPE_COLORS = {
  claim:    '#C8A448',   // gold          — the thesis, protagonist
  ground:   '#A0B8C8',   // silver-blue   — desaturated, subordinate
  warrant:  '#A8A0C4',   // silver-violet — desaturated, subordinate
  backing:  '#90A8A0',   // silver-teal   — desaturated, background
  rebuttal: '#C89080',   // dusty rose    — muted opposition signal
};

// Node fill colors (nearly transparent — shape carries meaning)
const NODE_FILLS = {
  claim:    'rgba(200,164,72,0.14)',
  ground:   'rgba(255,255,255,0.04)',
  warrant:  'rgba(255,255,255,0.04)',
  backing:  'rgba(255,255,255,0.03)',
  rebuttal: 'rgba(200,120,100,0.08)',
};

// Node border colors
const NODE_STROKES = {
  claim:    'rgba(200,164,72,0.65)',
  ground:   'rgba(180,200,215,0.35)',
  warrant:  'rgba(180,180,210,0.30)',
  backing:  'rgba(170,195,190,0.25)',
  rebuttal: 'rgba(200,130,110,0.48)',
};

// ── Node sizes ──
const TYPE_SIZES = {
  claim: 24, ground: 15, warrant: 18,
  backing: 13, rebuttal: 16
};

// ── Edge colours — muted palette, gold for claim connections ──
const EDGE_COLORS = {
  supports:    'rgba(200,164,72,0.40)',    // gold  — claim bond
  based_on:    'rgba(180,200,215,0.22)',   // silver-blue
  reinforces:  'rgba(180,180,210,0.18)',   // silver-violet
  challenges:  'rgba(200,130,110,0.45)',   // dusty rose
  derives_from:'rgba(200,164,72,0.18)',    // faded gold
};

// ── Shape icons for type labels ──
const TYPE_SHAPES = {
  claim:    'C',
  ground:   'G',
  warrant:  'W',
  backing:  'B',
  rebuttal: 'R',
};

// ── Node attribute resolvers (claim/warrant use type key; statement uses primary_role) ──
function nodeColor(n) {
  if (n.type === 'statement') return TYPE_COLORS[n.data?.primary_role || 'ground'] || TYPE_COLORS.ground;
  return TYPE_COLORS[n.type] || '#8E8E93';
}
function nodeFill(n) {
  if (n.type === 'statement') return NODE_FILLS[n.data?.primary_role || 'ground'] || NODE_FILLS.ground;
  return NODE_FILLS[n.type] || 'rgba(255,255,255,0.04)';
}
function nodeStroke(n) {
  if (n.type === 'statement') return NODE_STROKES[n.data?.primary_role || 'ground'] || NODE_STROKES.ground;
  return NODE_STROKES[n.type] || 'rgba(255,255,255,0.18)';
}
function nodeSize(n) {
  if (n.type === 'statement') return TYPE_SIZES[n.data?.primary_role || 'ground'] || TYPE_SIZES.ground;
  return TYPE_SIZES[n.type] || 18;
}
function nodeShapeLabel(n) {
  if (n.type === 'statement') return TYPE_SHAPES[n.data?.primary_role || 'ground'] || 'G';
  return TYPE_SHAPES[n.type] || '?';
}

// ── Global state ──
let svg, g, zoomBehavior, simulation;
let graphData = { nodes: [], edges: [], stats: {} };
let selectedNodeId = null;
let selectedNodeIds = new Set();
let nodeMap = new Map();
let nodePositionMap = new Map();
let currentLayout = 'tree';
let selectionMode = 'pan'; // 'box' | 'pan'
let positionCache = new Map(); // node id → {x, y}, survives re-renders
let userHasMoved = false;      // true after any user-initiated pan/zoom
