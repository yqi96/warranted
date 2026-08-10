/**
 * Warranted — Tag similarity matching for near-match detection
 *
 * Pure functions, zero dependencies.
 * Near-match checking is only needed for bounded namespaces (a few dozen members),
 * so no FTS or spellfix is needed.
 */

// =============================================================================
// Thresholds (module-level constants for easy tuning)
// =============================================================================

/** Minimum prefix length for token-level prefix equivalence */
const PREFIX_MIN_LENGTH = 3;

/** Minimum token length for intra-token Levenshtein check */
const INTRA_TOKEN_LEV_MIN_LENGTH = 5;

/** Maximum Levenshtein distance for intra-token equivalence */
const INTRA_TOKEN_LEV_MAX = 1;

/** Fuzzy Jaccard similarity threshold */
const JACCARD_THRESHOLD = 0.5;

/** Whole-string Levenshtein fallback threshold */
const WHOLE_STRING_LEV_MAX = 2;

/** Minimum length for whole-string Levenshtein fallback (avoid false positives on short strings) */
const WHOLE_STRING_LEV_MIN_LENGTH = 5;

/** Maximum number of near-match suggestions to return */
const MAX_SUGGESTIONS = 3;

// =============================================================================
// Levenshtein distance
// =============================================================================

/** Compute Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// =============================================================================
// Token helpers
// =============================================================================

/** Split a tag name (without namespace) into tokens on `-` and `_` */
function tokenize(name: string): string[] {
  return name.split(/[-_]/).filter(t => t.length > 0);
}

/**
 * Judge whether two individual tokens are equivalent:
 * - exact match, or
 * - prefix relation with the shorter side ≥3 characters, or
 * - intra-token Levenshtein ≤1 with both sides ≥5 characters
 */
function tokensEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  // Prefix relation: shorter side ≥ PREFIX_MIN_LENGTH
  if (a.length >= PREFIX_MIN_LENGTH && b.startsWith(a)) return true;
  if (b.length >= PREFIX_MIN_LENGTH && a.startsWith(b)) return true;
  // Intra-token Levenshtein: both sides ≥ INTRA_TOKEN_LEV_MIN_LENGTH, dist ≤ INTRA_TOKEN_LEV_MAX
  if (a.length >= INTRA_TOKEN_LEV_MIN_LENGTH && b.length >= INTRA_TOKEN_LEV_MIN_LENGTH) {
    if (levenshtein(a, b) <= INTRA_TOKEN_LEV_MAX) return true;
  }
  return false;
}

// =============================================================================
// Jaccard similarity with greedy pairing
// =============================================================================

/**
 * Compute fuzzy Jaccard similarity using greedy pairing via tokensEquivalent.
 * similarity = M / (|A| + |B| - M) where M is the number of matched pairs.
 */
function fuzzyJaccard(tokensA: string[], tokensB: string[]): number {
  const used = new Set<number>();
  let matches = 0;
  for (const a of tokensA) {
    for (let j = 0; j < tokensB.length; j++) {
      if (used.has(j)) continue;
      if (tokensEquivalent(a, tokensB[j])) {
        used.add(j);
        matches++;
        break;
      }
    }
  }
  const union = tokensA.length + tokensB.length - matches;
  return union > 0 ? matches / union : 0;
}

// =============================================================================
// Main comparison
// =============================================================================

/**
 * Check if two tag names are similar (within same namespace).
 * Returns true if same namespace and names are similar.
 */
export function isSimilar(a: string, b: string): boolean {
  const aColon = a.indexOf(":");
  const bColon = b.indexOf(":");
  if (aColon === -1 || bColon === -1) return false;
  const aNs = a.slice(0, aColon);
  const bNs = b.slice(0, bColon);
  if (aNs !== bNs) return false;
  return compareNames(a.slice(aColon + 1), b.slice(bColon + 1)) > 0;
}

/**
 * Find similar tags among candidates (adapter for test compatibility).
 * Returns NearMatch objects with name, count, score properties.
 */
export function findSimilarTags(name: string, candidates: string[]): NearMatch[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c, 1);
  const cardinalityLookup = (_ns: string): "dense" | "bounded" | null => null;
  return findNearMatches(name, candidates, counts, cardinalityLookup);
}

export interface NearMatch {
  name: string;
  count: number;
  score: number;
}

/**
 * Compare two tag names (without namespace) and return a similarity score.
 * Returns a value in [0, 1] where higher = more similar; 0 means "not a near match".
 * Score is `max(Jaccard, 1 − lev / maxLen)` per §5.2.
 */
function compareNames(nameA: string, nameB: string): number {
  // Rule 1 & 2: token fuzzy equivalence feeding fuzzy Jaccard
  const jaccard = fuzzyJaccard(tokenize(nameA), tokenize(nameB));

  // Rule 3: whole-string Levenshtein fallback (long enough to avoid false positives)
  const lev = levenshtein(nameA, nameB);
  const levEligible =
    lev <= WHOLE_STRING_LEV_MAX &&
    nameA.length >= WHOLE_STRING_LEV_MIN_LENGTH &&
    nameB.length >= WHOLE_STRING_LEV_MIN_LENGTH;

  if (jaccard < JACCARD_THRESHOLD && !levEligible) return 0;

  const maxLen = Math.max(nameA.length, nameB.length);
  const levScore = maxLen > 0 ? 1 - lev / maxLen : 0;
  return Math.max(jaccard, levScore);
}

/**
 * Find near-match tags for a given tag name.
 *
 * @param tagName - The full tag name (e.g., "theme:retrieval-aug")
 * @param allTags - Array of all registered tag names (full names)
 * @param tagCounts - Map of tag name → node count
 * @param namespaceCardinality - Function to check if a namespace is declared dense
 * @returns Sorted array of near matches (up to MAX_SUGGESTIONS), each with name, count, and score
 */
export function findNearMatches(
  tagName: string,
  allTags: string[],
  tagCounts: Map<string, number>,
  namespaceCardinality: (ns: string) => "dense" | "bounded" | null
): NearMatch[] {
  const colonIdx = tagName.indexOf(":");
  if (colonIdx === -1) return [];

  const namespace = tagName.slice(0, colonIdx);
  const namePart = tagName.slice(colonIdx + 1);

  // Skip if namespace is declared dense
  const cardinality = namespaceCardinality(namespace);
  if (cardinality === "dense") return [];

  const results: NearMatch[] = [];

  for (const candidate of allTags) {
    if (candidate === tagName) continue;

    const cColonIdx = candidate.indexOf(":");
    if (cColonIdx === -1) continue;
    const cNamespace = candidate.slice(0, cColonIdx);

    // Compare only within the same namespace
    if (cNamespace !== namespace) continue;

    const cNamePart = candidate.slice(cColonIdx + 1);
    const score = compareNames(namePart, cNamePart);
    if (score > 0) {
      results.push({
        name: candidate,
        count: tagCounts.get(candidate) ?? 0,
        score,
      });
    }
  }

  // Sort by score descending, then by name ascending
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return results.slice(0, MAX_SUGGESTIONS);
}