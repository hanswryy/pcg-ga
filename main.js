/**
 * main.js — Multi-Channel Memory Telemetry Harness
 *
 * WHAT CHANGED vs. the original:
 *   - SGA / MGA classes and their parameters are UNTOUCHED.
 *   - Only the orchestration layer (this file) has been redesigned.
 *
 * MEASUREMENT CHANNELS (all new):
 *   A  High-resolution heap time-series  — performance.memory every generation
 *   B  GC-pause inference                — PerformanceObserver longtask + long-animation-frame
 *   C  Allocation counters               — lightweight global counter incremented at every
 *                                          Matrix construction (the only "algorithm-side touch":
 *                                          a single ++ in Matrix's constructor wrapper below)
 *   D  Frame-timing disruption           — requestAnimationFrame inter-frame delta
 *   E  Retained-set audit (end-of-seed)  — window.gc() + performance.memory snapshot
 *      (Channel E' — measureUserAgentSpecificMemory if COOP/COEP is available)
 *
 * ORCHESTRATION CHANGES:
 *   - One warm-up seed (seed+0) is run and DISCARDED before the 5 measured seeds.
 *   - The 5 measured seeds run back-to-back in ONE TAB, no reload, accumulating any
 *     retained state — this is the deliberate stressor (Blackburn et al. DaCapo 2006).
 *   - Generations are driven by requestAnimationFrame, not a tight for-loop, so V8
 *     can interleave GC work between ticks (Degenbaev et al. 2016, ACM Queue).
 *   - Results are reported as p50/p95/p99 + mean +/- 95% CI (Georges et al. OOPSLA 2007).
 *
 * CHROME FLAGS REQUIRED (document in Chapter III §Konfigurasi Lingkungan):
 *   --enable-precise-memory-info          removes 10 MB bucket quantisation
 *   --js-flags=--expose-gc                enables window.gc() for retained-set snapshots
 *   --enable-experimental-web-platform-features   enables LoAF entries
 */

import * as THREE from 'three';
import { Matrix }          from './matrix.js';
import SGA, { TILE_TYPES } from './sga.js';
import MGA                 from './mga.js';
import MGA_NoShrink         from './mga_no_ps.js';
import { setSeed }         from './seeded-random.js';

// =============================================================================
// THREE.js scene setup  (unchanged from original)
// =============================================================================
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
camera.position.z = 50;

const startSgaButton = document.getElementById('start-sga');
const startMgaButton = document.getElementById('start-mga');
const startMgaNoShrinkButton = document.getElementById('start-mga-no-shrink');
const fitnessDisplay = document.getElementById('fitness-display');

let gridGroup = new THREE.Group();
scene.add(gridGroup);

// =============================================================================
// CHANNEL C — global allocation counter
//
// We patch Matrix.prototype.init from outside Matrix.js so Matrix.js stays
// completely unmodified.  The patch adds one integer increment per Matrix
// construction — O(1) overhead, dwarfed by the deep-copy cost that already
// exists in SGA.eClone().
//
// WHY THIS IS NOT AN ALGORITHM CHANGE:
//   It does not alter any computation inside SGA or MGA.
//   It is equivalent to placing a counting sensor on the factory floor —
//   the factory's output is identical, we only count how many units roll off.
// =============================================================================
let _allocationCounter = 0;   // total Matrix objects constructed this seed
let _cellCounter       = 0;   // total cells written (allocations x width x height)

const _OriginalMatrixInit = Matrix.prototype.init;
Matrix.prototype.init = function (...args) {
    _allocationCounter++;
    // width and height are set by the constructor before init() is called
    _cellCounter += (this.width || 10) * (this.height || 10);
    return _OriginalMatrixInit.apply(this, args);
};

function resetAllocationCounters() {
    _allocationCounter = 0;
    _cellCounter       = 0;
}

// =============================================================================
// CHANNEL B — GC-pause inference via PerformanceObserver
//
// V8 major (mark-compact) GC runs on the main thread and shows up as longtask
// entries > 50 ms.  The Long Animation Frames (LoAF) API additionally exposes
// blockingDuration — the unattributed main-thread work within a frame, which
// includes V8 GC work.
//
// Both observers are created ONCE at startup and are active across all seeds.
// Per-seed slicing uses the performance.now() timestamps recorded at each
// seed's start and end.
// =============================================================================
const _pauseEntries = [];   // raw pause-like entries across the whole session

function attachPauseObservers() {
    // longtask — fires for any main-thread task > 50 ms (includes major GC)
    try {
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                _pauseEntries.push({
                    type:             'longtask',
                    startTime:        entry.startTime,
                    duration:         entry.duration,
                    blockingDuration: entry.blockingDuration ?? entry.duration,
                });
            }
        }).observe({ type: 'longtask', buffered: true });
    } catch (e) {
        console.warn('[Telemetry] longtask observer unavailable:', e.message);
    }

    // long-animation-frame — Chrome 123+; exposes blockingDuration per frame
    try {
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                _pauseEntries.push({
                    type:             'long-animation-frame',
                    startTime:        entry.startTime,
                    duration:         entry.duration,
                    blockingDuration: entry.blockingDuration ?? 0,
                });
            }
        }).observe({ type: 'long-animation-frame', buffered: true });
    } catch (e) {
        console.warn('[Telemetry] long-animation-frame observer unavailable:', e.message);
    }
}

/** Return pause entries whose startTime falls within [startMs, endMs]. */
function collectPausesInRange(startMs, endMs) {
    return _pauseEntries.filter(
        e => e.startTime >= startMs && (e.startTime + e.duration) <= endMs
    );
}

// =============================================================================
// CHANNEL A — high-resolution heap sampler
// =============================================================================
function sampleHeap() {
    if (!performance.memory) return null;
    return {
        t:     performance.now(),
        used:  performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit,
    };
}

// =============================================================================
// CHANNEL D — frame-timing tracker
//
// One requestAnimationFrame tick per generation means each generation is
// exactly one frame.  Inter-frame delta > 16.67 ms = a dropped frame.
// This directly measures WebGL responsiveness disruption caused by GC pauses.
// =============================================================================
const FRAME_BUDGET_MS = 1000 / 60;  // 16.67 ms

function makeFrameTracker() {
    let _prev    = null;
    let _dropped = 0;
    let _maxDt   = 0;
    const _deltas = [];

    return {
        tick(now) {
            if (_prev !== null) {
                const dt = now - _prev;
                _deltas.push(dt);
                if (dt > FRAME_BUDGET_MS) _dropped++;
                if (dt > _maxDt) _maxDt = dt;
            }
            _prev = now;
        },
        report() {
            const mean = _deltas.length
                ? _deltas.reduce((a, b) => a + b, 0) / _deltas.length
                : 0;
            return { droppedFrames: _dropped, maxFrameMs: _maxDt, meanFrameMs: mean };
        },
    };
}

// =============================================================================
// CHANNEL E — retained-set snapshot
//
// Called once at the END of each seed (not between generations) to avoid
// polluting timing measurements with forced-GC overhead.
// Requires --js-flags=--expose-gc for window.gc().
// Requires COOP + COEP for measureUserAgentSpecificMemory().
// =============================================================================
async function retainedSetSnapshot() {
    if (typeof window.gc === 'function') window.gc();  // flush short-lived garbage

    const result = { gcAvailable: typeof window.gc === 'function' };

    const snap = sampleHeap();
    if (snap) {
        result.retainedUsedBytes  = snap.used;
        result.retainedTotalBytes = snap.total;
    }

    if (typeof performance.measureUserAgentSpecificMemory === 'function') {
        try {
            const mem = await performance.measureUserAgentSpecificMemory();
            result.measureUserAgentBytes = mem.bytes;
        } catch (e) {
            result.measureUserAgentBytes = null;
            result.measureUserAgentError = e.message;
        }
    }

    return result;
}

// =============================================================================
// STATISTICS HELPERS
// =============================================================================

/**
 * Allocation rate in MB/s from the heap time-series.
 * Sums only positive deltas (= allocation events) and divides by elapsed time.
 * This captures churn, not steady-state — the key metric that Hertz & Berger
 * (OOPSLA 2005) show drives GC overhead.
 */
function estimateAllocationRateMBs(heapSamples) {
    if (heapSamples.length < 2) return 0;
    let totalAllocated = 0;
    for (let i = 1; i < heapSamples.length; i++) {
        const delta = heapSamples[i].used - heapSamples[i - 1].used;
        if (delta > 0) totalAllocated += delta;
    }
    const durationSec = (heapSamples[heapSamples.length - 1].t - heapSamples[0].t) / 1000;
    return durationSec > 0 ? (totalAllocated / (1024 * 1024)) / durationSec : 0;
}

/**
 * Linear-regression slope of usedJSHeapSize over time (bytes/ms).
 * A positive slope indicates heap growth / potential retention leak.
 */
function heapGrowthSlope(heapSamples) {
    const n = heapSamples.length;
    if (n < 2) return 0;
    const xs = heapSamples.map(s => s.t);
    const ys = heapSamples.map(s => s.used);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - xMean) * (ys[i] - yMean);
        den += (xs[i] - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
}

/** p-th percentile of a sorted numeric array (0-100). */
function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

/**
 * 95% CI half-width using Student-t.
 * Georges et al. (OOPSLA 2007) recommend this for small-sample benchmarks.
 * t critical: df=1→12.706, df=2→4.303, df=3→3.182, df=4→2.776
 */
function ci95(values) {
    const n = values.length;
    if (n < 2) return 0;
    const mean     = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const se       = Math.sqrt(variance / n);
    const tTable   = [0, 12.706, 4.303, 3.182, 2.776];
    const t        = tTable[Math.min(n - 1, tTable.length - 1)] ?? 2.0;
    return t * se;
}

/** Aggregate N seed records into mean/CI/percentile per metric. */
function aggregateSeedReports(reports) {
    if (reports.length === 0) return {};

    const keys = [
        'peakUsedMB', 'finalRetainedMB', 'allocRateMBs',
        'heapGrowthSlopeKBs', 'runtimeMs', 'allocCount',
        'cellCount', 'allocBytesEstMB', 'longTaskCount',
        'droppedFrames', 'maxFrameMs',
        'pauseP50ms', 'pauseP95ms', 'pauseP99ms', 'pauseMaxMs', 'totalPauseMs',
    ];

    const agg = {};
    for (const k of keys) {
        const vals = reports.map(r => r[k] ?? 0);
        const sorted = [...vals].sort((a, b) => a - b);
        const mean   = vals.reduce((a, b) => a + b, 0) / vals.length;
        agg[k] = {
            mean,
            ci95:   ci95(vals),
            median: percentile(sorted, 50),
            min:    sorted[0],
            max:    sorted[sorted.length - 1],
            values: vals,
        };
    }
    return agg;
}

// =============================================================================
// CORE SEED RUNNER
//
// Runs exactly one full GA seed (2000 generations) and returns a telemetry
// record.  One generation per requestAnimationFrame tick so:
//   (a) V8 idle-time GC can interleave between ticks (Degenbaev et al. 2016).
//   (b) Frame-timing disruption by stop-the-world GC is captured in Channel D.
//   (c) PerformanceObserver callbacks fire between ticks (async-safe).
// =============================================================================
function _runSeedWithGrid(AlgoClass, seed) {
    return new Promise(resolve => {
        setSeed(seed);
        const algo = new AlgoClass(50);
        algo.initializePopulation();

        const GENERATIONS  = 2000;
        const seedStartMs  = performance.now();
        const heapSamples  = [];
        const frameTracker = makeFrameTracker();

        resetAllocationCounters();

        let gen = 0;

        function step(now) {
            frameTracker.tick(now);

            if (gen < GENERATIONS) {
                algo.evolve();

                // Channel A: one sample per generation
                const snap = sampleHeap();
                if (snap) heapSamples.push(snap);

                gen++;
                requestAnimationFrame(step);
            } else {
                // ── seed complete ────────────────────────────────────────────
                const seedEndMs = performance.now();

                retainedSetSnapshot().then(retained => {
                    // Channel B
                    const pauses         = collectPausesInRange(seedStartMs, seedEndMs);
                    const pauseDurations = pauses.map(e => e.duration).sort((a, b) => a - b);
                    const totalPauseMs   = pauseDurations.reduce((s, d) => s + d, 0);

                    // Channel A derived
                    const usedValues = heapSamples.map(s => s.used);
                    const peakUsed   = usedValues.length ? Math.max(...usedValues) : 0;

                    // Channel C snapshot
                    const allocCount    = _allocationCounter;
                    const cellCount     = _cellCounter;
                    // Estimated bytes: ~56 B object header + 8 B per cell
                    const allocBytesEst = allocCount * 56 + cellCount * 8;

                    const frameReport = frameTracker.report();
                    const best        = algo.getBestIndividual();

                    resolve({
                        seed,
                        fitness:            best?.fitness ?? 0,
                        _bestGrid:          best?.individual ?? null,
                        runtimeMs:          seedEndMs - seedStartMs,

                        // A
                        peakUsedMB:         peakUsed / (1024 * 1024),
                        finalRetainedMB:    (retained.retainedUsedBytes ?? 0) / (1024 * 1024),
                        allocRateMBs:       estimateAllocationRateMBs(heapSamples),
                        heapGrowthSlopeKBs: heapGrowthSlope(heapSamples) * 1000 / 1024,
                        heapSamples,

                        // B
                        pauseDurations,
                        longTaskCount:      pauses.length,
                        pauseP50ms:         percentile(pauseDurations, 50),
                        pauseP95ms:         percentile(pauseDurations, 95),
                        pauseP99ms:         percentile(pauseDurations, 99),
                        pauseMaxMs:         pauseDurations[pauseDurations.length - 1] ?? 0,
                        totalPauseMs,

                        // C
                        allocCount,
                        cellCount,
                        allocBytesEstMB:    allocBytesEst / (1024 * 1024),

                        // D
                        droppedFrames:      frameReport.droppedFrames,
                        maxFrameMs:         frameReport.maxFrameMs,
                        meanFrameMs:        frameReport.meanFrameMs,

                        // E
                        ...retained,
                    });
                });
            }
        }

        requestAnimationFrame(step);
    });
}

// =============================================================================
// TOP-LEVEL RUNNER  —  warm-up + 5 measured seeds, back-to-back, one tab
// =============================================================================
const LEVEL_COUNT  = 1;
const WARMUP_SEEDS = 1;   // discarded — lets JIT and inline-caches stabilise

let _running = false;   // prevent concurrent button presses

async function _runAndRender(AlgoClass, algoName, baseSeed) {
    // ── Warm-up (discarded) ──────────────────────────────────────────────────
    fitnessDisplay.textContent = `[${algoName}] Warming up (seed ${baseSeed})…`;
    for (let w = 0; w < WARMUP_SEEDS; w++) {
        await _runSeedWithGrid(AlgoClass, baseSeed + w);
    }

    // ── Measured seeds ───────────────────────────────────────────────────────
    const seedReports = [];
    const bestGrids   = [];

    for (let s = 0; s < LEVEL_COUNT; s++) {
        const seed = baseSeed + WARMUP_SEEDS + s;
        fitnessDisplay.textContent = `[${algoName}] Measuring seed ${s + 1} / ${LEVEL_COUNT} (seed=${seed})…`;
        performance.mark(`seed-${algoName}-${s}-start`);

        const record = await _runSeedWithGrid(AlgoClass, seed);
        seedReports.push(record);
        if (record._bestGrid) bestGrids.push(record._bestGrid);

        console.log(
            `[${algoName}] seed=${seed}` +
            `  fitness=${record.fitness.toFixed(4)}` +
            `  peakHeap=${record.peakUsedMB.toFixed(2)} MB` +
            `  retained=${record.finalRetainedMB.toFixed(2)} MB` +
            `  allocRate=${record.allocRateMBs.toFixed(2)} MB/s` +
            `  slope=${record.heapGrowthSlopeKBs.toFixed(2)} KB/s` +
            `  longTasks=${record.longTaskCount}` +
            `  p50pause=${record.pauseP50ms.toFixed(1)} ms` +
            `  p95pause=${record.pauseP95ms.toFixed(1)} ms` +
            `  p99pause=${record.pauseP99ms.toFixed(1)} ms` +
            `  maxPause=${record.pauseMaxMs.toFixed(1)} ms` +
            `  dropped=${record.droppedFrames}` +
            `  allocs=${record.allocCount}` +
            `  allocEst=${record.allocBytesEstMB.toFixed(2)} MB` +
            `  runtime=${record.runtimeMs.toFixed(0)} ms`
        );

        performance.mark(`seed-${algoName}-${s}-end`);
    }

    // ── Aggregate + display ──────────────────────────────────────────────────
    const agg = aggregateSeedReports(seedReports);
    _logAggregateReport(algoName, agg);
    _updateDisplay(algoName, seedReports, agg);
    renderMultipleGrids(bestGrids);
}

// =============================================================================
// LOGGING
// =============================================================================
function _logAggregateReport(name, agg) {
    const fmt = (k, unit = '') => {
        const a = agg[k];
        if (!a) return `  ${k}: no data`;
        return `  ${k}: mean=${a.mean.toFixed(3)}${unit}  ±CI95=${a.ci95.toFixed(3)}` +
               `  p50=${a.median.toFixed(3)}${unit}  min=${a.min.toFixed(3)}${unit}  max=${a.max.toFixed(3)}${unit}`;
    };

    console.group(`[${name}] AGGREGATE — ${LEVEL_COUNT} seeds (Georges et al. OOPSLA 2007 methodology)`);
    console.log(fmt('peakUsedMB',           ' MB'));
    console.log(fmt('finalRetainedMB',      ' MB'));
    console.log(fmt('allocRateMBs',         ' MB/s'));
    console.log(fmt('heapGrowthSlopeKBs',   ' KB/s'));
    console.log(fmt('allocCount',           ' objects'));
    console.log(fmt('allocBytesEstMB',      ' MB (est)'));
    console.log(fmt('longTaskCount',        ''));
    console.log(fmt('pauseP50ms',           ' ms'));
    console.log(fmt('pauseP95ms',           ' ms'));
    console.log(fmt('pauseP99ms',           ' ms'));
    console.log(fmt('pauseMaxMs',           ' ms'));
    console.log(fmt('totalPauseMs',         ' ms'));
    console.log(fmt('droppedFrames',        ''));
    console.log(fmt('maxFrameMs',           ' ms'));
    console.log(fmt('runtimeMs',            ' ms'));

    // Raw JSON for reproducible archiving
    const raw = Object.fromEntries(
        Object.entries(agg).map(([k, v]) => [k, v.values])
    );
    console.log(`[${name}] RAW JSON (copy to spreadsheet):`);
    console.log(JSON.stringify(raw, null, 2));
    console.groupEnd();
}

function _updateDisplay(algoName, reports, agg) {
    const avgFitness = (reports.reduce((s, r) => s + r.fitness, 0) / reports.length).toFixed(4);
    const p = (k, dec = 2) => agg[k]?.mean.toFixed(dec) ?? 'N/A';

    fitnessDisplay.textContent =
        `[${algoName}] fitness=${avgFitness} | ` +
        `peakHeap=${p('peakUsedMB')} MB | ` +
        `retained=${p('finalRetainedMB')} MB | ` +
        `allocRate=${p('allocRateMBs')} MB/s | ` +
        `slope=${p('heapGrowthSlopeKBs')} KB/s | ` +
        `longTasks=${p('longTaskCount', 1)} | ` +
        `p95pause=${p('pauseP95ms')} ms | ` +
        `dropped=${p('droppedFrames', 1)} frames`;
}

// =============================================================================
// BUTTON HANDLERS
// =============================================================================
async function runSGA(baseSeed) {
    if (_running) return;
    _running = true;
    startSgaButton.disabled = true;
    startMgaButton.disabled = true;
    if (startMgaNoShrinkButton) startMgaNoShrinkButton.disabled = true;
    try {
        await _runAndRender(SGA, 'SGA', baseSeed);
    } finally {
        _running = false;
        startSgaButton.disabled = false;
        startMgaButton.disabled = false;
        if (startMgaNoShrinkButton) startMgaNoShrinkButton.disabled = false;
    }
}

async function runMGA(baseSeed) {
    if (_running) return;
    _running = true;
    startSgaButton.disabled = true;
    startMgaButton.disabled = true;
    if (startMgaNoShrinkButton) startMgaNoShrinkButton.disabled = true;
    try {
        await _runAndRender(MGA, 'MGA', baseSeed);
    } finally {
        _running = false;
        startSgaButton.disabled = false;
        startMgaButton.disabled = false;
        if (startMgaNoShrinkButton) startMgaNoShrinkButton.disabled = false;
    }
}

async function runMGA_NoShrink(baseSeed) {
    if (_running) return;
    _running = true;
    startSgaButton.disabled = true;
    startMgaButton.disabled = true;
    if (startMgaNoShrinkButton) startMgaNoShrinkButton.disabled = true;
    try {
        await _runAndRender(MGA_NoShrink, 'MGA(no-shrink)', baseSeed);
    } finally {
        _running = false;
        startSgaButton.disabled = false;
        startMgaButton.disabled = false;
        if (startMgaNoShrinkButton) startMgaNoShrinkButton.disabled = false;
    }
}

startSgaButton.addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed-input').value) || 0;
    runSGA(seed);
});

startMgaButton.addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed-input').value) || 0;
    runMGA(seed);
});

if (startMgaNoShrinkButton) {
    startMgaNoShrinkButton.addEventListener('click', () => {
        const seed = parseInt(document.getElementById('seed-input').value) || 0;
        runMGA_NoShrink(seed);
    });
}

// =============================================================================
// RENDERING (unchanged from original)
// =============================================================================
function getColorForTile(tileType) {
    switch (tileType) {
        case TILE_TYPES.EMPTY:  return 0xffffff;
        case TILE_TYPES.WALL:   return 0x808080;
        case TILE_TYPES.HAZARD: return 0xff0000;
        case TILE_TYPES.ITEM:   return 0xffff00;
        case TILE_TYPES.START:  return 0x00ff00;
        case TILE_TYPES.END:    return 0x0000ff;
        default:                return 0x000000;
    }
}

function renderMultipleGrids(individuals) {
    while (gridGroup.children.length > 0) {
        const obj = gridGroup.children[0];
        obj.geometry.dispose();
        obj.material.dispose();
        gridGroup.remove(obj);
    }

    const geometry   = new THREE.PlaneGeometry(1, 1);
    const gap        = 2;
    const totalWidth = individuals.reduce((sum, ind) => sum + (ind?.width ?? 10), 0)
                     + gap * (individuals.length - 1);
    let offsetX = -totalWidth / 2;

    for (const individual of individuals) {
        if (!individual) { offsetX += 10 + gap; continue; }
        for (let i = 0; i < individual.height; i++) {
            for (let j = 0; j < individual.width; j++) {
                const color    = getColorForTile(individual.get(j, i));
                const material = new THREE.MeshBasicMaterial({ color });
                const plane    = new THREE.Mesh(geometry, material);
                plane.position.x = offsetX + j + 0.5;
                plane.position.y = i - individual.height / 2;
                gridGroup.add(plane);
            }
        }
        offsetX += individual.width + gap;
    }
}

// =============================================================================
// STARTUP
// =============================================================================
attachPauseObservers();   // Channel B — must fire before any GA runs

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}
animate();