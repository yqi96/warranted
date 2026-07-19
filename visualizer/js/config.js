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

// ── Global state ──
let svg, g, zoomBehavior, simulation;
let graphData = { nodes: [], edges: [], stats: {} };
let selectedNodeId = null;
let selectedNodeIds = new Set();
let nodeMap = new Map();
let nodePositionMap = new Map();
let currentLayout = 'tree';
