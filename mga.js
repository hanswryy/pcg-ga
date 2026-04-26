import { Matrix } from './matrix.js';
import { aStar } from './a-star.js';
import { random } from './seeded-random.js';

// Tile types
export const TILE_TYPES = {
    START: 0,
    END: 1,
    EMPTY: 2,
    WALL: 3,
    HAZARD: 4,
    ITEM: 5,
};

const NUM_CRITERIA = 4;   // symmetry, emptyBalance, playerExitDist, safeZone
const LAMBDA       = 0.5; // Dissertation Section 2.4, Eq. 2.18:
                           // "λ is defined as 0.5 to have a neutral impact"
const EPSILON      = 1e-9; // Guard against zero divisors in kia/kib/kic

class MGA {
    constructor(populationSize = 50, width = 10, height = 10) {
        this.populationSize = populationSize;
        this.activePopulationSize = populationSize;
        this.width  = width;
        this.height = height;

        // ── Teknik 1: Static Memory Pooling ───────────────────────────────────
        // Pre-alokasi seluruh buffer matriks kromosom sekaligus di awal program.
        // Tidak ada Matrix baru yang dibuat selama siklus generasi berlangsung.
        this.population     = [];
        this.nextPopulation = [];

        // Buffer indeks untuk Tournament Selection — tidak pernah diganti
        this.selectedIndicesBuffer = new Array(populationSize);

        // Pre-alokasi buffer criteria matrix (satu baris per individu)
        // Digunakan kembali setiap generasi tanpa alokasi baru — CoCoSo Step 1
        this.criteriaMatrixBuffer = Array.from(
            { length: populationSize }, () => new Float64Array(NUM_CRITERIA)
        );

        // Pre-alokasi buffer Ri dan Pi per individu — CoCoSo Eqs. 2.22–2.23
        // Float64Array digunakan agar tidak ada objek JS baru per individu
        this.riBuffer = new Float64Array(populationSize); // weighted sum
        this.piBuffer = new Float64Array(populationSize); // weighted product

        // Pre-alokasi buffer untuk tiga appraisal scores per individu
        // kia (Eq. 2.26), kib (Eq. 2.31), kic (Eq. 2.32)
        this.kiaBuffer = new Float64Array(populationSize);
        this.kibBuffer = new Float64Array(populationSize);
        this.kicBuffer = new Float64Array(populationSize);

        for (let i = 0; i < populationSize; i++) {
            this.population.push({
                individual: new Matrix(width, height),
                fitness: 0
            });
            this.nextPopulation.push({
                individual: new Matrix(width, height),
                fitness: 0
            });
        }

        this.evolutionHistory = [];
        this.generation = 0;

        this.criteriaWeights = [0.25, 0.25, 0.25, 0.25];

        // ── CoCoSo global boundary state ──────────────────────────────────────
        // Dissertation Section 2.4.1:
        // "The normalisation process is adjusted to utilise the smallest
        //  criterion values across all generations rather than relying solely
        //  on values generated within a single generation."
        //
        // Unlike SGA which retains full criteriaMatrixHistory to recompute
        // these each generation, MGA maintains only running scalar extremes —
        // four min values and four max values — updated in-place each generation.
        // This is the memory-optimised form: O(1) storage instead of O(n*l).
        this.globalCriteriaMin = new Float64Array(NUM_CRITERIA).fill(Infinity);
        this.globalCriteriaMax = new Float64Array(NUM_CRITERIA).fill(-Infinity);

        // CoCoSo global Ri/Pi bounds — Dissertation Eqs. 2.27–2.30
        // r1 = global min Ri, r2 = global min Pi
        // p1 = global max Ri, p2 = global max Pi
        // Again stored as four scalars instead of full riPiHistory.
        this.r1 = Infinity;
        this.r2 = Infinity;
        this.p1 = -Infinity;
        this.p2 = -Infinity;

        // CoCoSo constant A — Dissertation Eq. 2.24
        // A = Σ all past ki / nl  (running mean across all chromosomes × generations)
        // Stored as two scalars (sum + count) instead of full fitnessHistory.
        this.fitnessSum   = 0;
        this.fitnessCount = 0;

        // Pengaturan untuk penyusutan populasi dinamis (Teknik 3)
        this.shrinkGeneration = 50;
        this.shrinkFactor     = 0.5;
    }

    // Initialize population
    initializePopulation() {
        // Cukup isi individu yang sudah ada, tidak perlu membuat baru
        for (let i = 0; i < this.populationSize; i++) {
            this.createIndividual(this.population[i].individual);
            this.population[i].fitness = 0;
        }
        this.evaluatePopulation();
    }

    // Create a single individual
    createIndividual(individual) {
        // Fill with random tiles
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                // Random between 2 and 5 (EMPTY, WALL, HAZARD, ITEM)
                const tileType = Math.floor(random() * 4) + 2;
                individual.set(x, y, tileType);
            }
        }

        // Place one start and one end tile at random positions
        let startX, startY, endX, endY;
        
        do {
            startX = Math.floor(random() * individual.width);
            startY = Math.floor(random() * individual.height);
            endX = Math.floor(random() * individual.width);
            endY = Math.floor(random() * individual.height);
        } while (startX === endX && startY === endY);

        individual.set(startX, startY, TILE_TYPES.START);
        individual.set(endX, endY, TILE_TYPES.END);
    }

    // Evaluate the fitness of the entire population using neutrosophic CoCoSo
    // Dissertation Section 2.4 (Eqs. 2.11–2.19) + Section 2.4.1 (Eqs. 2.20–2.32)
    //
    // Memory strategy: all intermediate values are written into pre-allocated
    // Float64Array buffers. No new objects or arrays are created here.
    evaluatePopulation() {

        // ── STEP 1 ── Fill criteria matrix buffer  (Dissertation Eq. 2.11) ────
        // Overwrite criteriaMatrixBuffer in-place — no new arrays allocated.
        for (let i = 0; i < this.activePopulationSize; i++) {
            const chromosome = this.population[i].individual;

            if (!this.constraintsSatisfied(chromosome)) {
                this.population[i].fitness = 0;
                this.criteriaMatrixBuffer[i][0] = 0;
                this.criteriaMatrixBuffer[i][1] = 0;
                this.criteriaMatrixBuffer[i][2] = 0;
                this.criteriaMatrixBuffer[i][3] = 0;
                continue;
            }

            this.criteriaMatrixBuffer[i][0] = this.calculateSymmetry(chromosome);
            this.criteriaMatrixBuffer[i][1] = this.calculateEmptySpaceBalance(chromosome);
            this.criteriaMatrixBuffer[i][2] = this.calculatePlayerExitDistance(chromosome);
            this.criteriaMatrixBuffer[i][3] = this.calculateSafeZone(chromosome);
        }

        // ── PRE-STEP ── Update global criteria bounds in-place ────────────────
        // Dissertation Section 2.4.1:
        // "The normalisation process is adjusted to utilise the smallest
        //  criterion values across all generations."
        //
        // MGA optimisation vs SGA: instead of scanning a full criteriaMatrixHistory
        // array (O(n*l) memory, O(n*l) scan time), we maintain only four running
        // min scalars and four running max scalars updated here in O(n) per generation.
        for (let i = 0; i < this.activePopulationSize; i++) {
            for (let j = 0; j < NUM_CRITERIA; j++) {
                const v = this.criteriaMatrixBuffer[i][j];
                if (v < this.globalCriteriaMin[j]) this.globalCriteriaMin[j] = v;
                if (v > this.globalCriteriaMax[j]) this.globalCriteriaMax[j] = v;
            }
        }

        // Guard: avoid division by zero when min === max
        for (let j = 0; j < NUM_CRITERIA; j++) {
            if (this.globalCriteriaMax[j] === this.globalCriteriaMin[j])
                this.globalCriteriaMax[j] = this.globalCriteriaMin[j] + 1;
        }

        // ── STEPS 2, 3 & 4 ── Normalise → Neutrosophicate → Ri and Pi ─────────
        // Dissertation Eq. 2.12: rij = (xij - global_min_j) / (global_max_j - global_min_j)
        // Dissertation Eq. 2.20: N(t) = C  (linear conversion, t = rij)
        // Dissertation Eqs. 2.22–2.23: Ri = Σ wj*t,  Pi = Π t^wj
        //
        // MGA optimisation: N(t,i,f) sets are never stored. Following Petrovas's
        // own final implementation: "research incrementally adds and multiplies
        // them to generate the Ri and Pi values without having to store individual
        // elements for each one." Results written directly into riBuffer/piBuffer.
        for (let i = 0; i < this.activePopulationSize; i++) {
            let Ri = 0;
            let Pi = 1;

            for (let j = 0; j < NUM_CRITERIA; j++) {
                const lo  = this.globalCriteriaMin[j];
                const hi  = this.globalCriteriaMax[j];

                // Eq. 2.12 normalisation, clamped to [0.1, 0.9] per Section 2.4.1:
                // "Criteria scores are computed and normalised to fit within
                //  the range of 0.1 to 0.9."
                const rij = Math.min(0.9, Math.max(0.1,
                    (this.criteriaMatrixBuffer[i][j] - lo) / (hi - lo)
                ));

                // Eq. 2.20: t = C (truth = normalised scalar, inline — not stored)
                const t = rij;
                const w = this.criteriaWeights[j];

                Ri += w * t;          // Eq. 2.22
                Pi *= Math.pow(t, w); // Eq. 2.23
            }

            this.riBuffer[i] = Ri;
            this.piBuffer[i] = Pi;

            // Update running global Ri/Pi bounds in-place — Eqs. 2.27–2.30
            // MGA optimisation: replaces full riPiHistory scan (SGA) with
            // four running scalars updated per individual.
            if (Ri < this.r1) this.r1 = Ri;
            if (Pi < this.r2) this.r2 = Pi;
            if (Ri > this.p1) this.p1 = Ri;
            if (Pi > this.p2) this.p2 = Pi;
        }

        // Guard degenerate bounds
        if (this.p1 === this.r1) this.p1 = this.r1 + EPSILON;
        if (this.p2 === this.r2) this.p2 = this.r2 + EPSILON;

        // ── STEP 5 ── Constant A and divisor d  (Eqs. 2.24–2.25) ─────────────
        // A = Σ all past ki / nl
        // MGA optimisation: replaces full fitnessHistory array (SGA) with
        // two running scalars (fitnessSum, fitnessCount).
        // On generation 0 no past fitness exists, so A defaults to 1.
        const A = this.fitnessCount > 0
            ? this.fitnessSum / this.fitnessCount
            : 1;
        const d = this.activePopulationSize * A; // Eq. 2.25

        // ── STEP 6 ── Appraisal scores kia, kib, kic → final ki ──────────────
        // Results written into pre-allocated kia/kib/kicBuffers — no new objects.
        for (let i = 0; i < this.activePopulationSize; i++) {
            const Ri = this.riBuffer[i];
            const Pi = this.piBuffer[i];

            // kia — arithmetic mean of Ri and Pi relative to d  (Eq. 2.26)
            this.kiaBuffer[i] = (Ri + Pi) / (d + EPSILON);

            // kib — relative score vs global min  (Eq. 2.31)
            this.kibBuffer[i] = (Ri / (this.r1 + EPSILON)) +
                                 (Pi / (this.r2 + EPSILON));

            // kic — balanced compromise  (Eq. 2.32)
            this.kicBuffer[i] =
                (LAMBDA * Ri + (1 - LAMBDA) * Pi) /
                (LAMBDA * this.p1 + (1 - LAMBDA) * this.p2 + EPSILON);

            // ki — final ranking score  (Eq. 2.19)
            const ki = Math.pow(
                    Math.abs(this.kiaBuffer[i] * this.kibBuffer[i] * this.kicBuffer[i]),
                    1 / 3
                ) + (1 / 3) * (this.kiaBuffer[i] + this.kibBuffer[i] + this.kicBuffer[i]);

            this.population[i].fitness = ki;

            // Accumulate into running A totals — Teknik 4 (direct primitive write)
            this.fitnessSum   += ki;
            this.fitnessCount += 1;
        }
    }

    constraintsSatisfied(individual) {
        let startPos, endPos;
        let wallCount = 0;
        let floorCount = 0;

        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                const tile = individual.get(x, y);
                if (tile === TILE_TYPES.START) startPos = { x, y };
                if (tile === TILE_TYPES.END) endPos = { x, y };
                if (tile === TILE_TYPES.WALL) wallCount++;
                if (tile === TILE_TYPES.EMPTY) floorCount++;
            }
        }

        const c1 = startPos ? 1 : 0;
        const c2 = endPos ? 1 : 0;
        
        // A* pathfinding
        const c3 = this.hasPath(individual, startPos, endPos) ? 1 : 0; 

        // Immediately return true or false
        return c1 === 1 && c2 === 1 && c3 === 1;
    }

    calculateSymmetry(chromosome) {
        let totalSymmetry = 0.0;
        let w = chromosome.width;
        let h = chromosome.height;

        // Pengecekan Sumbu Horizontal (Kiri dicerminkan ke Kanan)
        for (let x = 0; x < w / 2; x++) {
            for (let y = 0; y < h; y++) {
                if (chromosome.get(x, y) === chromosome.get(w - x - 1, y)) {
                    // Sesuai flowchart: totalSymetry += 1.0f / (gridSizeX * gridSizeY)
                    totalSymmetry += 1.0 / (w * h); 
                }
            }
        }

        // Pengecekan Sumbu Vertikal (Atas dicerminkan ke Bawah)
        // Karena paper menyebut "each object is measured twice for each axis",
        // kita melakukan pemindaian silang yang sama untuk sumbu Y.
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h / 2; y++) {
                if (chromosome.get(x, y) === chromosome.get(x, h - y - 1)) {
                    totalSymmetry += 1.0 / (w * h);
                }
            }
        }

        return totalSymmetry; // Nilai maksimal = 1.0
    }

    // 2. Kriteria Empty-Space Balance (Estetika)
    // Berdasarkan Gambar 4 (Flowchart) dan Persamaan 2 & 3 pada paper.
    calculateEmptySpaceBalance(chromosome) {
        let emptySpaceCount = 0;
        let totalCells = chromosome.width * chromosome.height;

        // Menghitung jumlah Empty Space (angka 2) di seluruh grid
        for (let y = 0; y < chromosome.height; y++) {
            for (let x = 0; x < chromosome.width; x++) {
                if (chromosome.get(x, y) === 2) {
                    emptySpaceCount++;
                }
            }
        }

        // Menghitung seberapa dekat rasio ruang kosong dengan angka 50%
        let halfCells = totalCells / 2.0;
        let t = emptySpaceCount;

        // Jika ruang kosong lebih dari 50%, nilainya dibalik (reversed) 
        // sesuai dengan persamaan t = (1/2 * xy) - t1 - (1/2 * xy)
        if (t > halfCells) {
            t = totalCells - t;
        }

        // Normalisasi akhir e = t / (0.5 * xy)
        return t / halfCells; // Nilai maksimal = 1.0
    }

    // 3. Kriteria Player-Exit Distance (Fungsionalitas)
    // Berdasarkan Persamaan 4 pada paper.
    calculatePlayerExitDistance(chromosome) {
        let pX = -1, pY = -1, eX = -1, eY = -1;

        // Mencari koordinat Player (0) dan Exit (1)
        for (let y = 0; y < chromosome.height; y++) {
            for (let x = 0; x < chromosome.width; x++) {
                let tile = chromosome.get(x, y);
                if (tile === 0) {
                    pX = x;
                    pY = y;
                } else if (tile === 1) {
                    eX = x;
                    eY = y;
                }
            }
        }

        // Jika player atau exit tidak ditemukan, kembalikan 0 (jarak terburuk)
        if (pX === -1 || eX === -1) return 0;

        // Rumus Jarak Euclidean: d = sqrt((x2 - x1)^2 + (y2 - y1)^2)
        let dx = eX - pX;
        let dy = eY - pY;
        let distance = Math.sqrt((dx * dx) + (dy * dy));

        return distance;
    }

    calculateSafeZone(chromosome) {
        let pX = -1, pY = -1;

        // Cari koordinat Player (0) terlebih dahulu
        for (let y = 0; y < chromosome.height; y++) {
            for (let x = 0; x < chromosome.width; x++) {
                if (chromosome.get(x, y) === 0) {
                    pX = x;
                    pY = y;
                    break;
                }
            }
            if (pX !== -1) break;
        }

        if (pX === -1) return 0; // Jika tidak ada player, anggap tidak aman

        let hazardCount = 0;
        let radius = 2; // Merepresentasikan "defined square" 5x5 di sekitar pemain
        let totalSquareArea = Math.pow((radius * 2) + 1, 2); // 25 kotak

        // Scan kotak 5x5 di sekitar titik koordinat pemain
        for (let y = pY - radius; y <= pY + radius; y++) {
            for (let x = pX - radius; x <= pX + radius; x++) {
                // Pastikan indeks tidak keluar dari batas matriks (Out of Bounds)
                if (x >= 0 && x < chromosome.width && y >= 0 && y < chromosome.height) {
                    if (chromosome.get(x, y) === 4) { // 4 adalah Hazard/Musuh
                        hazardCount++;
                    }
                }
            }
        }

        // Persamaan 5 menghitung rasio kepadatan Hazard.
        // Karena nilai 0 adalah yang terburuk dan 1 adalah yang terbaik (paling aman),
        // kita mengurangi 1.0 dengan rasio bahaya tersebut.
        let hazardRatio = hazardCount / totalSquareArea;
        let safeZoneScore = 1.0 - hazardRatio;

        // Memastikan nilai tidak negatif jika area dipenuhi musuh secara ekstrem
        return Math.max(0, safeZoneScore); // Nilai maksimal = 1.0
    }

    // A* pathfinding algorithm
    hasPath(individual, start, end) {
        if (!start || !end) return false;
        return aStar(individual, start, end);
    }

    // 2. Metode Seleksi bebas alokasi (Tournament Selection berbasis Indeks)
    tournamentSelection(k = 3) {
        let bestIndex = -1;
        let bestFitness = -1;

        for (let i = 0; i < k; i++) {
            const randomIndex = Math.floor(random() * this.activePopulationSize);
            if (this.population[randomIndex].fitness > bestFitness) {
                bestFitness = this.population[randomIndex].fitness;
                bestIndex = randomIndex;
            }
        }
        return bestIndex;
    }

    // Evolve the population to the next generation
    evolve() {
        // if (!this.evolutionHistory) this.evolutionHistory = [];
        // // Simpan snapshot dari populasi aktif saat ini
        // const currentActivePopulation = [];
        // for(let i = 0; i < this.activePopulationSize; i++) {
        //     currentActivePopulation.push({
        //         individual: this.clone(this.population[i].individual),
        //         fitness: this.population[i].fitness
        //     });
        // }
        // this.evolutionHistory.push(currentActivePopulation);

        // 4. Penyusutan Populasi Dinamis
        if (this.generation === this.shrinkGeneration) {
            this.activePopulationSize = Math.floor(this.activePopulationSize * this.shrinkFactor);
        }

        // Buat populasi baru tanpa alokasi baru (menggunakan buffer yang ada)
        for (let i = 0; i < this.activePopulationSize; i++) {
            this.selectedIndicesBuffer[i] = this.tournamentSelection();
        }

        // Overwrite data ke nextPopulation tanpa membuat objek baru
        for(let i = 0; i < this.activePopulationSize; i++) {
            const parentIndex = this.selectedIndicesBuffer[i];
            const parentMatrix = this.population[parentIndex].individual;
            const targetMatrix = this.nextPopulation[i].individual;
            
            for (let y = 0; y < this.height; y++) {
                for (let x = 0; x < this.width; x++) {
                    targetMatrix.set(x, y, parentMatrix.get(x, y));
                }
            }
            this.nextPopulation[i].fitness = this.population[parentIndex].fitness;
        }

        // Swap penunjuk populasi
        let temp = this.population;
        this.population = this.nextPopulation;
        this.nextPopulation = temp;

        // Terapkan mutasi pada paruh kedua dari populasi aktif
        for (let i = Math.floor(this.activePopulationSize / 2); i < this.activePopulationSize; i++) {
            this.mutate(this.population[i].individual);
        }
        
        this.evaluatePopulation();
        this.generation++;
    }

    // Clone an individual (digunakan untuk history dan penyalinan sementara)
    clone(individual) {
        const newIndividual = new Matrix(individual.width, individual.height);
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                newIndividual.set(x, y, individual.get(x, y));
            }
        }
        return newIndividual;
    }

    // 3. Modifikasi Memori Langsung (Mutasi)
    mutate(individual, mutationRate = 0.05) {
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                if (random() < mutationRate) {
                    const currentTile = individual.get(x, y);
                    // Hindari mutasi pada tile start/end
                    if (currentTile !== TILE_TYPES.START && currentTile !== TILE_TYPES.END) {
                        // Pastikan tile baru berbeda dari yang lama
                        let newTile;
                        do {
                            newTile = Math.floor(random() * 4) + 2;
                        } while (newTile === currentTile);
                        
                        individual.set(x, y, newTile);
                    }
                }
            }
        }
    }

    // Get the best individual from the current population
    getBestIndividual() {
        let bestFitness = -1;
        let bestIndividual = null;
        for (let i = 0; i < this.activePopulationSize; i++) {
            if (this.population[i].fitness > bestFitness) {
                bestFitness = this.population[i].fitness;
                bestIndividual = this.population[i];
            }
        }
        return bestIndividual;
    }
}

export default MGA;