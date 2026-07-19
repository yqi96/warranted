// ── Semantic node color system ──
// Each node type has a distinct hue that reflects its argumentative role.
// All hues are calibrated to similar luminosity so they harmonize at a glance.
// Gold (#C8A448) remains the product accent and the claim protagonist color.

const TYPE_COLORS = {
  claim:    '#C8A448',   // gold        — the thesis, protagonist
  ground:   '#5B9BD5',   // steel blue  — empirical evidence, cool and measured
  warrant:  '#9B7FCE',   // violet      — logical inference, rule-based
  backing:  '#5EA87A',   // sage green  — stable background support
  rebuttal: '#C86A5A',   // coral       — opposition, tension
};

// Node fill colors (translucent tinted surfaces)
const NODE_FILLS = {
  claim:    'rgba(200,164,72,0.14)',
  ground:   'rgba(91,155,213,0.10)',
  warrant:  'rgba(155,127,206,0.10)',
  backing:  'rgba(94,168,122,0.08)',
  rebuttal: 'rgba(200,106,90,0.12)',
};

// Node border colors
const NODE_STROKES = {
  claim:    'rgba(200,164,72,0.55)',
  ground:   'rgba(91,155,213,0.45)',
  warrant:  'rgba(155,127,206,0.40)',
  backing:  'rgba(94,168,122,0.38)',
  rebuttal: 'rgba(200,106,90,0.50)',
};

// ── Node sizes ──
const TYPE_SIZES = {
  claim: 24, ground: 15, warrant: 18,
  backing: 13, rebuttal: 16
};

// ── Edge colours — semantically typed ──
const EDGE_COLORS = {
  supports:    'rgba(200,164,72,0.40)',    // gold    — claim←warrant bond
  based_on:    'rgba(91,155,213,0.35)',    // blue    — warrant←ground bond
  reinforces:  'rgba(155,127,206,0.30)',   // violet  — warrant reinforcement
  challenges:  'rgba(200,106,90,0.50)',    // coral   — rebuttal opposition
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
let nodeMap = new Map();
let nodePositionMap = new Map();
let currentLayout = 'tree';
