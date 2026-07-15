---
name: declare-barrier
description: Use this to officially close out a task you cannot complete. Generates the required documentation to formally mark something as blocked and move on.
---

Stop. Do not write "this cannot be done" until you have completed every step below.

## The core principle

A barrier you have not systematically challenged is a lazy excuse, not a scientific conclusion. The categories below represent recurring patterns of false barriers — they appear in nearly every complex reproduction task. Check every one before accepting any block.

---

## Recurring patterns of false barriers

### Pattern 1: "The algorithm is not accessible"
**Almost always false.** Ask:
- Did you read the Methods section of the paper, word for word?
- Did you read the cited reference for that algorithm?
- Did you search GitHub, PyPI, CRAN for an existing implementation?
- Did you search Google Scholar for "algorithm name + implementation" or "algorithm name + Python"?

If the algorithm is described in a published paper, it is accessible. Complexity is not inaccessibility.

### Pattern 2: "The data is not available"
**Often false.** Check in order:
1. The paper's "Data availability" section
2. The paper's supplementary materials
3. Standard public archives: Zenodo, Figshare, PANGAEA, NOAA, CMIP5/6, GitHub
4. Your local `data/` directory — the data may already be there
5. A representative subset — full dataset unavailability does not prevent partial verification

### Pattern 3: "This is too slow"
**Almost always solvable.** Before accepting:
- Profile first: where exactly is the bottleneck?
- Precompute anything that is recomputed repeatedly
- Vectorize: replace Python loops with NumPy operations
- Cache: store intermediate results to disk
- Approximate: a 10× faster approximation that gives qualitatively correct results IS a valid partial verification
- Reduce: verify correctness on a small subset (10% of members, 1 of N experiments) before scaling

### Pattern 4: "This is too complex to implement"
**Complexity is not impossibility.** Every algorithm is composed of simpler components. Decompose:
1. What is the core mathematical operation?
2. What are the inputs and outputs?
3. Which standard library functions cover each component?
4. Implement the simplest possible version first and check if results are in the right ballpark.

### Pattern 5: "I implemented it but got wrong results — so it cannot be verified"
**Wrong conclusion.** Wrong results mean wrong implementation, not unverifiable science. Ask:
- Did you implement the correct algorithm or a superficially similar one? (Re-read the Methods section.)
- Are results qualitatively correct even if quantitatively different?
- Is the quantitative difference explained by a known methodological difference (e.g., different proxy set, different fingerprint source)?
- Quantitative difference ≠ qualitative mismatch. Verify direction first.

### Pattern 6: "The scope is too broad to verify"
**Reducibility, not impossibility.** When a task covers N subjects and you can only cover M < N:
- Define a narrower sub-task covering only the M you can verify
- Document exactly what the reduced scope covers and what it excludes
- A verified sub-result with clear scope documentation IS a real result

### Pattern 7: "The library / tool / API is not available"
**Check before assuming:**
- `pip install`, `conda install`, `apt-get install`
- Is there an alternative library that provides the same functionality?
- Is there a minimal reimplementation of the specific function you need?

### Pattern 8: "I don't know where to start"
**Not a barrier — a planning problem.** Steps:
1. Write down the input and output of the computation
2. Find one example of the output format (even a simplified toy example)
3. Implement the transformation from input to output for that toy example
4. Scale up

---

## The interrogation checklist

Before classifying a barrier, answer every question:

**Algorithm**
- [ ] Methods section read word-for-word?
- [ ] All cited algorithm papers read?
- [ ] GitHub/PyPI/CRAN searched for existing implementation?
- [ ] Simplified version attempted?

**Data**
- [ ] Paper's data availability section checked?
- [ ] Supplementary materials checked?
- [ ] Standard public archives checked?
- [ ] Local data directory checked?
- [ ] Subset sufficient for partial verification?

**Implementation**
- [ ] Bottleneck profiled before claiming "too slow"?
- [ ] Algorithm decomposed into components?
- [ ] Toy example implemented to verify understanding?

**Scope**
- [ ] Narrower sub-task defined?
- [ ] Sub-task scope boundaries documented explicitly?

---

## Classification

**Class A — False barrier (solvable now)**
Path is clear after interrogation. Implement immediately.

**Class B — Reducible barrier (partially solvable)**
Full scope unverifiable, but a sub-task is verifiable. Define the narrower scope and complete it. Record scope limitations explicitly.

**Class C — Real barrier**
Must satisfy ALL of:
1. Algorithm not described in any accessible publication
2. Required data absent from all public archives and unobtainable
3. No scientifically defensible approximation exists
4. Class B sub-task verification already completed

If you cannot satisfy all four, it is not Class C.

---

## Documentation requirements

**Class A**: Implement. No extra documentation.

**Class B**:
- Define the narrower sub-task with exact scope boundaries in the description document
- Document explicitly what the full scope requires and why the remainder is unverifiable

**Class C** (only after all four conditions met):
- Write in the task description: what was searched for, where, and why no approximation is valid
- Record status as blocked with honest accounting of what was attempted
