import { Matrix } from './matrix.js';
import { aStar } from './a-star.js';
import { random } from './seeded-random.js';

// ---------------------------------------------------------------------------
// Tile encoding — Dissertation Section 2.1.1
// "Each number represents a different object type."
// ---------------------------------------------------------------------------
export const TILE_TYPES = {
    START:  0,  // "Player (number 0)"
    END:    1,  // "Exit (number 1)"
    EMPTY:  2,  // "Empty space (number 2)"
    WALL:   3,  // "Wall (number 3)"
    HAZARD: 4,  // "Hazzard or enemy (number 4)"
    ITEM:   5,  // "Collectible (number 5)"
};

// symmetry, emptyBalance, playerExitDist, safeZone
const NUM_CRITERIA = 4;

// Dissertation Section 2.4, Eq. 2.18:
// "λ is defined as 0.5 to have a neutral impact"
const LAMBDA       = 0.5; 

class SGA {
    constructor(populationSize = 50) {
        // Dissertation Section 2.2:
        // "The population size is set to 50."
        this.populationSize = populationSize;
        this.population     = [];
        this.generation     = 0;

        // Equal weights for all four criteria — dissertation applies no
        // unequal weighting in the base CoCoSo generator.
        this.criteriaWeights = [0.25, 0.25, 0.25, 0.25];
        this.criteriaMatrixHistory = [];
        this.riPiHistory = [];
        this.fitnessHistory = [];
        this.populationSnapshots = [];

        // Global criterion min/max across all generations (Eq. 2.12)
        this.globalCriteriaMin = new Array(NUM_CRITERIA).fill(Infinity);
        this.globalCriteriaMax = new Array(NUM_CRITERIA).fill(-Infinity);

        // Global Ri/Pi min/max across all generations (Eqs. 2.27–2.30)
        this.r1 = Infinity;   // global min of all Ri
        this.r2 = Infinity;   // global min of all Pi
        this.p1 = -Infinity;  // global max of all Ri
        this.p2 = -Infinity;  // global max of all Pi

        // Running totals for constant A (Eq. 2.24)
        this.fitnessSum   = 0; // Σ all past ki values
        this.fitnessCount = 0; // = n * l after l generations
    }

    // -------------------------------------------------------------------------
    // INITIALISE POPULATION
    // Dissertation Section 2.2 / Fig. 2.14: "InitializeRandomPopulation"
    // -------------------------------------------------------------------------
    initializePopulation() {
        this.population = [];
        for (let i = 0; i < this.populationSize; i++) {
            const individual = new Matrix();
            this.createIndividual(individual);
            this.population.push({ individual, fitness: 0 });
        }
        this.evaluatePopulation();
    }

    // -------------------------------------------------------------------------
    // CREATE A SINGLE INDIVIDUAL (chromosome)
    // Dissertation Section 2.1.1:
    // "each object is coded with integer numbers from 2 to 6"
    // "add 1 Player and 1 Exit object"
    // -------------------------------------------------------------------------
    createIndividual(individual) {
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                individual.set(x, y, Math.floor(random() * 4) + 2);
            }
        }

        let startX, startY, endX, endY;
        do {
            startX = Math.floor(random() * individual.width);
            startY = Math.floor(random() * individual.height);
            endX   = Math.floor(random() * individual.width);
            endY   = Math.floor(random() * individual.height);
        } while (startX === endX && startY === endY);

        individual.set(startX, startY, TILE_TYPES.START);
        individual.set(endX,   endY,   TILE_TYPES.END);
    }

    // -------------------------------------------------------------------------
    // UPDATE GLOBAL CRITERIA BOUNDS from [STORE A]
    // Dissertation Section 2.4, Eq. 2.12 + Section 2.4.1:
    // "The normalisation process is adjusted to utilise the smallest criterion
    //  values across all generations rather than relying solely on values
    //  generated within a single generation."
    //
    // Scans every row of every past criteriaMatrix entry and updates
    // globalCriteriaMin/Max per criterion. Called at the top of every
    // evaluatePopulation() call — [STORE A] is causally upstream of all
    // normalisation, Ri/Pi computation, and fitness scoring this generation.
    // -------------------------------------------------------------------------
    _updateGlobalCriteriaBounds() {
        this.globalCriteriaMin = new Array(NUM_CRITERIA).fill(Infinity);
        this.globalCriteriaMax = new Array(NUM_CRITERIA).fill(-Infinity);

        for (const entry of this.criteriaMatrixHistory) {
            for (const row of entry.criteriaMatrix) {
                for (let j = 0; j < NUM_CRITERIA; j++) {
                    if (row[j] < this.globalCriteriaMin[j])
                        this.globalCriteriaMin[j] = row[j];
                    if (row[j] > this.globalCriteriaMax[j])
                        this.globalCriteriaMax[j] = row[j];
                }
            }
        }

        // Guards: handle generation 0 (no history yet) and flat criteria
        for (let j = 0; j < NUM_CRITERIA; j++) {
            if (this.globalCriteriaMin[j] === Infinity)
                this.globalCriteriaMin[j] = 0;
            if (this.globalCriteriaMax[j] === -Infinity ||
                this.globalCriteriaMax[j] === this.globalCriteriaMin[j])
                this.globalCriteriaMax[j] = this.globalCriteriaMin[j] + 1;
        }
    }

    // -------------------------------------------------------------------------
    // UPDATE GLOBAL Ri/Pi BOUNDS from [STORE B]
    // Dissertation Eqs. 2.27–2.30:
    // r1 = min over all i in nl of Ri
    // r2 = min over all i in nl of Pi
    // p1 = max over all i in nl of Ri
    // p2 = max over all i in nl of Pi
    //
    // These four scalars feed kib (Eq. 2.31) and kic (Eq. 2.32) for every
    // chromosome this generation. [STORE B] must exist for this to work.
    // -------------------------------------------------------------------------
    _updateGlobalRiPiBounds() {
        this.r1 = Infinity;
        this.r2 = Infinity;
        this.p1 = -Infinity;
        this.p2 = -Infinity;

        for (const entry of this.riPiHistory) {
            for (const rec of entry.records) {
                if (rec.Ri < this.r1) this.r1 = rec.Ri;
                if (rec.Pi < this.r2) this.r2 = rec.Pi;
                if (rec.Ri > this.p1) this.p1 = rec.Ri;
                if (rec.Pi > this.p2) this.p2 = rec.Pi;
            }
        }

        // Guards for generation 0 and degenerate cases
        if (this.r1 === Infinity)  this.r1 = 0;
        if (this.r2 === Infinity)  this.r2 = 0;
        if (this.p1 === -Infinity) this.p1 = 1;
        if (this.p2 === -Infinity) this.p2 = 1;
        if (this.p1 === this.r1)   this.p1 = this.r1 + 1e-9;
        if (this.p2 === this.r2)   this.p2 = this.r2 + 1e-9;
    }

    // -------------------------------------------------------------------------
    // EVALUATE POPULATION — full neutrosophic CoCoSo pipeline
    // Dissertation Section 2.4 (Eqs. 2.11–2.19) extended by
    // Section 2.4.1 (Eqs. 2.20–2.32)
    // -------------------------------------------------------------------------
    evaluatePopulation() {

        // ── PRE-STEP ── Update all global boundaries from stores ──────────────
        // Both methods must run before any normalisation or scoring this gen.
        this._updateGlobalCriteriaBounds(); // reads [STORE A]
        this._updateGlobalRiPiBounds();     // reads [STORE B]

        // ── STEP 1 ── Build criteria matrix X  (Dissertation Eq. 2.11) ────────
        // "The criteria evaluation data is consolidated into a matrix X, where
        //  one dimension represents the chromosome index, and the other
        //  represents the criteria index."
        const criteriaMatrix = [];

        for (const pop of this.population) {
            const chromosome = pop.individual;

            if (!this.constraintsSatisfied(chromosome)) {
                // Dissertation Section 2.1.2:
                // "If any of the constraint functions fail, the total fitness
                //  value is multiplied by zero."
                pop.fitness = 0;
                criteriaMatrix.push([0, 0, 0, 0]);
                continue;
            }

            criteriaMatrix.push([
                this.calculateSymmetry(chromosome),
                this.calculateEmptySpaceBalance(chromosome),
                this.calculatePlayerExitDistance(chromosome),
                this.calculateSafeZone(chromosome),
            ]);
        }

        // [STORE A] — Commit matrix X for this generation.
        // Every future call to _updateGlobalCriteriaBounds() will read this
        // entry, making it causally upstream of all future normalisations.
        this.criteriaMatrixHistory.push({
            generation:     this.generation,
            criteriaMatrix: criteriaMatrix.map(row => [...row]),
        });

        // ── STEP 2 ── Normalise rij using GLOBAL min/max  (Eq. 2.12) ──────────
        // rij = (xij - global_min_j) / (global_max_j - global_min_j)
        // "The normalisation process is adjusted to utilise the smallest
        //  criterion values across all generations."
        // Clamped to [0.1, 0.9] per Section 2.4.1:
        // "Criteria scores are computed and normalised to fit within the
        //  range of 0.1 to 0.9. The research avoids getting too close to 0 or
        //  1 to ensure a more reliable outcome for the MCDM algorithm."
        const normalisedMatrix = criteriaMatrix.map(row =>
            row.map((v, j) => {
                const lo  = this.globalCriteriaMin[j];
                const hi  = this.globalCriteriaMax[j];
                const rij = (v - lo) / (hi - lo);
                return Math.min(0.9, Math.max(0.1, rij));
            })
        );

        // ── STEPS 3 & 4 ── Neutrosophication + incremental Ri/Pi ─────────────
        // Dissertation Eq. 2.20 — neutrosophic linear conversion:
        // N = { t = C, i = 1 - C, f = 1 - C }
        // "linear conversion from crisp to neutrosophic numbers to prevent
        //  non-linear differences from accumulating over subsequent generations."
        //
        // Dissertation Eqs. 2.22–2.23:
        // Ri = Σ_j  wj * N(t)ij
        // Pi = Σ_j  N(t)ij ^ wj
        //
        // Petrovas's final implementation accumulates Ri and Pi inline without
        // storing the individual N(t,i,f) sets:
        // "research incrementally adds and multiplies them to generate the Ri
        //  and Pi values without having to store individual elements for each one."
        // This loop faithfully follows that decision — N(t,i,f) is computed per
        // criterion and immediately consumed, never stored as a collection.
        const generationRiPi = [];

        for (let i = 0; i < this.population.length; i++) {
            const normRow = normalisedMatrix[i];
            let Ri = 0;
            let Pi = 1;

            for (let j = 0; j < NUM_CRITERIA; j++) {
                const w = this.criteriaWeights[j];
                const t = normRow[j]; // N(t) = C (Eq. 2.20), computed inline

                Ri += w * t;          // Eq. 2.22: weighted sum accumulation
                Pi *= Math.pow(t, w); // Eq. 2.23: weighted product accumulation
            }

            generationRiPi.push({ chromosomeIndex: i, Ri, Pi });
        }

        // [STORE B] — Commit Ri and Pi for every chromosome this generation.
        // _updateGlobalRiPiBounds() reads all past entries to compute r1, r2,
        // p1, p2 (Eqs. 2.27–2.30) at the start of every future generation.
        this.riPiHistory.push({
            generation: this.generation,
            records:    generationRiPi.map(r => ({ ...r })),
        });

        // Also extend r1/r2/p1/p2 with THIS generation's Ri/Pi immediately
        // so kib and kic below reflect the most current global bounds.
        for (const rec of generationRiPi) {
            if (rec.Ri < this.r1) this.r1 = rec.Ri;
            if (rec.Pi < this.r2) this.r2 = rec.Pi;
            if (rec.Ri > this.p1) this.p1 = rec.Ri;
            if (rec.Pi > this.p2) this.p2 = rec.Pi;
        }
        if (this.p1 === this.r1) this.p1 = this.r1 + 1e-9;
        if (this.p2 === this.r2) this.p2 = this.r2 + 1e-9;

        // ── STEP 5 ── Constant A and divisor d  (Eqs. 2.24–2.25) ─────────────
        // A = Σ all past ki / nl   where nl = population size × generations
        // d = n * A
        // fitnessSum and fitnessCount accumulate from [STORE C] across all
        // generations. Generation 0 has no past fitness so A defaults to 1.
        const A = this.fitnessCount > 0
            ? this.fitnessSum / this.fitnessCount
            : 1;
        const d = this.populationSize * A; // Eq. 2.25

        // ── STEP 6 ── Appraisal scores kia, kib, kic and final ki ─────────────
        const EPSILON = 1e-9;
        const generationFitnessScores = [];

        for (let i = 0; i < this.population.length; i++) {
            const { Ri, Pi } = generationRiPi[i];

            // kia — arithmetic mean of WSM and WPM relative to d  (Eq. 2.26)
            // kia = (S(Ri) + S(Pi)) / d
            // For linear neutrosophic sets, S(Ri) = Ri and S(Pi) = Pi
            // (scalarization of N(t,i,f) where t=C yields back C directly)
            const kia = (Ri + Pi) / (d + EPSILON);

            // kib — relative scores vs global min Ri and Pi  (Eq. 2.31)
            // kib = S(Ri)/r1 + S(Pi)/r2
            const kib = (Ri / (this.r1 + EPSILON)) +
                        (Pi / (this.r2 + EPSILON));

            // kic — balanced compromise of WSM and WPM  (Eq. 2.32)
            // kic = (λ·S(Ri) + (1-λ)·S(Pi)) / (λ·p1 + (1-λ)·p2)
            const kic = (LAMBDA * Ri + (1 - LAMBDA) * Pi) /
                        (LAMBDA * this.p1 + (1 - LAMBDA) * this.p2 + EPSILON);

            // ki — final ranking score  (Eq. 2.19)
            // ki = (kia · kib · kic)^(1/3) + (1/3)·(kia + kib + kic)
            const ki = Math.pow(Math.abs(kia * kib * kic), 1 / 3) +
                       (1 / 3) * (kia + kib + kic);

            this.population[i].fitness = ki;
            generationFitnessScores.push({ chromosomeIndex: i, kia, kib, kic, ki, Ri, Pi });
        }

        // [STORE C] — Commit fitness scores for this generation.
        // fitnessSum and fitnessCount are updated so constant A (Eq. 2.24)
        // remains the true mean of all ki values across all generations so far.
        for (const rec of generationFitnessScores) {
            this.fitnessSum   += rec.ki;
            this.fitnessCount += 1;
        }

        this.fitnessHistory.push({
            generation: this.generation,
            scores:     generationFitnessScores.map(r => ({ ...r })),
        });

        // [STORE D] — Commit population snapshot for this generation.
        // Anchors each criteria matrix row in [STORE A] and each Ri/Pi record
        // in [STORE B] to the chromosome grid that produced them — making both
        // stores traceable, verifiable, and reproducible.
        this.populationSnapshots.push({
            generation: this.generation,
            chromosomes: this.population.map(p => ({
                grid:    this._snapshotGrid(p.individual),
                fitness: p.fitness,
            })),
        });
    }

    // -------------------------------------------------------------------------
    // CONSTRAINT CHECKING — Dissertation Section 2.1.2
    // c1 — Player object exists
    // c2 — Exit object exists
    // c3 — Passable path between Player and Exit (A* pathfinding)
    // -------------------------------------------------------------------------
    constraintsSatisfied(individual) {
        let startPos, endPos;

        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                const tile = individual.get(x, y);
                if (tile === TILE_TYPES.START) startPos = { x, y };
                if (tile === TILE_TYPES.END)   endPos   = { x, y };
            }
        }

        return !!startPos && !!endPos && this.hasPath(individual, startPos, endPos);
    }

    // -------------------------------------------------------------------------
    // CRITERION 1 — Symmetry  (Dissertation Eq. 2.1)
    // m = Σs / 2xy
    // -------------------------------------------------------------------------
    calculateSymmetry(chromosome) {
        let totalSymmetry = 0.0;
        const w = chromosome.width;
        const h = chromosome.height;

        for (let x = 0; x < w / 2; x++) {
            for (let y = 0; y < h; y++) {
                if (chromosome.get(x, y) === chromosome.get(w - x - 1, y))
                    totalSymmetry += 1.0 / (w * h);
            }
        }

        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h / 2; y++) {
                if (chromosome.get(x, y) === chromosome.get(x, h - y - 1))
                    totalSymmetry += 1.0 / (w * h);
            }
        }

        return totalSymmetry;
    }

    // -------------------------------------------------------------------------
    // CRITERION 2 — Empty-Space Balance  (Dissertation Eqs. 2.2–2.3)
    // e = t / (½·xy),  where t is reversed if it exceeds 50%
    // -------------------------------------------------------------------------
    calculateEmptySpaceBalance(chromosome) {
        let emptyCount   = 0;
        const totalCells = chromosome.width * chromosome.height;

        for (let y = 0; y < chromosome.height; y++) {
            for (let x = 0; x < chromosome.width; x++) {
                if (chromosome.get(x, y) === TILE_TYPES.EMPTY) emptyCount++;
            }
        }

        const halfCells = totalCells / 2.0;
        let t = emptyCount;
        if (t > halfCells) t = totalCells - t;

        return t / halfCells;
    }

    // -------------------------------------------------------------------------
    // CRITERION 3 — Player-Exit Distance  (Dissertation Eq. 2.4)
    // d = sqrt((x2-x1)^2 + (y2-y1)^2)
    // -------------------------------------------------------------------------
    calculatePlayerExitDistance(chromosome) {
        let pX = -1, pY = -1, eX = -1, eY = -1;

        for (let y = 0; y < chromosome.height; y++) {
            for (let x = 0; x < chromosome.width; x++) {
                const tile = chromosome.get(x, y);
                if (tile === TILE_TYPES.START) { pX = x; pY = y; }
                if (tile === TILE_TYPES.END)   { eX = x; eY = y; }
            }
        }

        if (pX === -1 || eX === -1) return 0;
        return Math.sqrt((eX - pX) ** 2 + (eY - pY) ** 2);
    }

    // -------------------------------------------------------------------------
    // CRITERION 4 — Safe Zone  (Dissertation Eq. 2.5)
    // z = x1y1 / x2y2  (hazard count in 5×5 window / window area)
    // -------------------------------------------------------------------------
    calculateSafeZone(chromosome) {
        let pX = -1, pY = -1;

        for (let y = 0; y < chromosome.height; y++) {
            for (let x = 0; x < chromosome.width; x++) {
                if (chromosome.get(x, y) === TILE_TYPES.START) {
                    pX = x; pY = y; break;
                }
            }
            if (pX !== -1) break;
        }

        if (pX === -1) return 0;

        const radius          = 2;
        const totalSquareArea = Math.pow((radius * 2) + 1, 2); // 25
        let hazardCount = 0;

        for (let y = pY - radius; y <= pY + radius; y++) {
            for (let x = pX - radius; x <= pX + radius; x++) {
                if (x >= 0 && x < chromosome.width &&
                    y >= 0 && y < chromosome.height) {
                    if (chromosome.get(x, y) === TILE_TYPES.HAZARD)
                        hazardCount++;
                }
            }
        }

        return Math.max(0, 1.0 - (hazardCount / totalSquareArea));
    }

    // -------------------------------------------------------------------------
    // CONSTRAINT c3 — A* pathfinding
    // Dissertation Section 2.1.2:
    // "Using a pathfinding algorithm to verify the existence of a passable
    //  route between the player and exit."
    // -------------------------------------------------------------------------
    hasPath(individual, start, end) {
        if (!start || !end) return false;
        return aStar(individual, start, end);
    }

    // -------------------------------------------------------------------------
    // EVOLVE — one generation cycle
    // Dissertation Section 2.2 / Fig. 2.14:
    // "chromosomes below the median value are replaced with chromosomes from
    //  the above-median array, and then 5% of the data in this new array is
    //  mutated by assigning new random values."
    // -------------------------------------------------------------------------
    evolve() {
        this.population.sort((a, b) => b.fitness - a.fitness);

        const topHalf = this.population.slice(0, this.populationSize / 2);

        const survivingParents = topHalf.map(p => ({
            individual: this.eClone(p.individual),
            fitness:    p.fitness,
        }));

        const offspring = topHalf.map(p => {
            const child = this.eClone(p.individual);
            this.eMutate(child, 0.05);
            return { individual: child, fitness: 0 };
        });

        this.population = [...survivingParents, ...offspring];

        this.evaluatePopulation();
        this.generation++;
    }

    // -------------------------------------------------------------------------
    // CLONE a chromosome (deep copy)
    // -------------------------------------------------------------------------
    eClone(individual) {
        const clone = new Matrix(individual.width, individual.height);
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                clone.set(x, y, individual.get(x, y));
            }
        }
        return clone;
    }

    // -------------------------------------------------------------------------
    // MUTATE a chromosome in-place
    // Dissertation Section 2.2:
    // "5% of the data in this new array is mutated by assigning new random values."
    // START and END tiles are never mutated (hard constraint preservation).
    // -------------------------------------------------------------------------
    eMutate(individual, mutationRate = 0.05) {
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                const current = individual.get(x, y);
                if (random() < mutationRate &&
                    current !== TILE_TYPES.START &&
                    current !== TILE_TYPES.END) {
                    let newTile;
                    do {
                        newTile = Math.floor(random() * 4) + 2;
                    } while (newTile === current);
                    individual.set(x, y, newTile);
                }
            }
        }
        return individual;
    }

    // -------------------------------------------------------------------------
    // HELPER — independent 2D array snapshot of a grid
    // -------------------------------------------------------------------------
    _snapshotGrid(individual) {
        const snap = [];
        for (let y = 0; y < individual.height; y++) {
            const row = [];
            for (let x = 0; x < individual.width; x++) {
                row.push(individual.get(x, y));
            }
            snap.push(row);
        }
        return snap;
    }

    // -------------------------------------------------------------------------
    // GET BEST INDIVIDUAL
    // Dissertation Fig. 2.14: "DrawGrid(best fitness)"
    // -------------------------------------------------------------------------
    getBestIndividual() {
        return this.population[0];
    }
}

export default SGA;
