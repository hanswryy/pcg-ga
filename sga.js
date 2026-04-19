import { Matrix } from './matrix.js';
import { aStar } from './a-star.js';

// Tile types
export const TILE_TYPES = {
    START: 0,
    END: 1,
    EMPTY: 2,
    WALL: 3,
    HAZARD: 4,
    ITEM: 5,
};

class SGA {
    constructor(populationSize = 50) {
        this.populationSize = populationSize;
        this.population = [];
        this.evolutionHistory = [];
        this.generation = 0;

        this.criteriaWeights = [0.25, 0.25, 0.25, 0.25];
        this.criteriaMaxValues = [1.0, 1.0, 28.28, 1.0];
    }

    // Initialize population
    initializePopulation() {
        this.population = [];
        for (let i = 0; i < this.populationSize; i++) {
            const individual = new Matrix();
            this.createIndividual(individual);
            this.population.push({ individual, fitness: 0 });
        }
        this.evaluatePopulation();
    }

    // Create a single individual
    createIndividual(individual) {
        // Fill with random tiles
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                // Random between 2 and 5 (EMPTY, WALL, HAZARD, ITEM)
                const tileType = Math.floor(Math.random() * 4) + 2;
                individual.set(x, y, tileType);
            }
        }

        // Place one start and one end tile at random positions
        let startX, startY, endX, endY;
        
        do {
            startX = Math.floor(Math.random() * individual.width);
            startY = Math.floor(Math.random() * individual.height);
            endX = Math.floor(Math.random() * individual.width);
            endY = Math.floor(Math.random() * individual.height);
        } while (startX === endX && startY === endY);

        individual.set(startX, startY, TILE_TYPES.START);
        individual.set(endX, endY, TILE_TYPES.END);
    }

    // Evaluate the fitness of the entire population
    evaluatePopulation() {
        // WASPAS #1: Data Matrix Creation
        let criteriaMatrix = [];

        for (const pop of this.population) {
            let chromosome = pop.individual;

            if (!this.constraintsSatisfied(chromosome)) {
                pop.fitness = 0;
                criteriaMatrix.push([0, 0, 0, 0]);
                continue;
            }

            let symmetry = this.calculateSymmetry(chromosome);
            let emptySpaceBalance = this.calculateEmptySpaceBalance(chromosome);
            let playerExitDistance = this.calculatePlayerExitDistance(chromosome);
            let safeZone = this.calculateSafeZone(chromosome);

            criteriaMatrix.push([symmetry, emptySpaceBalance, playerExitDistance, safeZone]);
        }

        for (let i = 0; i < this.population.length; i++) {
            let rawScores = criteriaMatrix[i];
            let neutrosophicSets = [];
        
            // WASPAS #2 & #3: Normalization and Neutrosophication
            for (let j = 0; j < rawScores.length; j++) {
                // Normalisasi (0 sampai 1)
                let normalizedS = rawScores[j] / this.criteriaMaxValues[j];
                
                // Mencegah nilai menyentuh angka absolut 1 (Aturan Petrovas)
                normalizedS = normalizedS * 0.9; 

                // Konversi skalar ke Himpunan Neutrosophic (Truth, Intermediacy, Falsehood)
                neutrosophicSets.push({
                    t: normalizedS,         // Truth (t)
                    i: 1 - normalizedS,     // Intermediacy (i)
                    f: 1 - normalizedS      // Falsehood (f)
                });
            }

            // WASPAS #4 & #5: Weighted Sum Model (WSM) & Weighted Product Model (WPM)
            let sum_t = 0;
            let prod_t = 1;

            for (let j = 0; j < neutrosophicSets.length; j++) {
                let weight = this.criteriaWeights[j];
                let truthVal = neutrosophicSets[j].t;

                // Kalkulasi WSM (Pendekatan Aritmatika Neutrosophic dari Flowchart Petrovas)
                let wsm_val = 1 - Math.pow(1 - truthVal, weight);
                sum_t = sum_t + wsm_val - (sum_t * wsm_val);

                // Kalkulasi WPM
                let wpm_val = Math.pow(truthVal, weight);
                prod_t = prod_t * wpm_val;
            }

            // WASPAS #6: Joint Generalized Criterion (Penggabungan WSM dan WPM)
            // Rumus: Q_i = 0.5 * WSM + 0.5 * WPM
            let Q_t = (0.5 * sum_t) + (0.5 * prod_t);
            
            // Asumsi untuk nilai intermediacy dan falsehood gabungan
            let Q_i = 1 - Q_t;
            let Q_f = 1 - Q_t;

            // WASPAS #7: Scalarization (Konversi kembali ke nilai Scalar untuk GA)
            // Rumus: S = (3 + t - 2i - f) / 4
            let finalFitnessScore = (3 + Q_t - (2 * Q_i) - Q_f) / 4;

            // Memasukkan hasil akhir sebagai nilai fitness kromosom tersebut
            this.population[i].fitness = finalFitnessScore;
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

    // Evolve the population to the next generation
    evolve() {
        // // Median-Cut selection: discard bottom 50%, clone top 50%
        // const topHalf = this.population.slice(0, this.populationSize / 2);
        // const newPopulation = [...topHalf, ...topHalf.map(p => ({ individual: this.clone(p.individual), fitness: p.fitness }))];
        
        // this.population = newPopulation;

        // // Apply mutation to the new population to introduce variation
        // for(let i = 0; i < this.population.length; i++) {
        //     if (i >= this.populationSize / 2) { // Only mutate the cloned half
        //         this.mutate(this.population[i].individual);
        //     }
        // }

        // this.evaluatePopulation();
        // this.generation++;
        
        if (!this.evolutionHistory) this.evolutionHistory = [];
        this.evolutionHistory.push([...this.population]);

        // Sort population by fitness in descending order
        this.population.sort((a, b) => b.fitness - a.fitness);

        const topHalf = this.population.slice(0, this.populationSize / 2);

        let survivingParents = topHalf.map(p => ({
            individual: this.eClone(p.individual),
            fitness: p.fitness
        }));

        let offspring = topHalf.map(p => {
            let childMatrix = this.eClone(p.individual);
            let mutatedChildMatrix = this.eMutate(childMatrix);
            return { individual: mutatedChildMatrix, fitness: 0 };
        });

        this.population = [...survivingParents, ...offspring];

        this.evaluatePopulation();
        this.generation++;
    }

    eClone(individual) {
        const newIndividual = new Matrix(individual.width, individual.height);
        
        const tempGrid = Array.from({ length: individual.height }, (_, y) => 
            Array.from({ length: individual.width }, (_, x) => individual.get(x, y))
        );

        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                newIndividual.set(x, y, tempGrid[y][x]);
            }
        }
        return newIndividual; 
    }

    // Clone an individual
    clone(individual) {
        const newIndividual = new Matrix();
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                newIndividual.set(x, y, individual.get(x, y));
            }
        }
        return newIndividual;
    }

    eMutate(individual, mutationRate = 0.01) {
        const mutatedIndividual = new Matrix(individual.width, individual.height);

        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                const currentTile = individual.get(x, y);
                
                if (Math.random() < mutationRate && currentTile !== TILE_TYPES.START && currentTile !== TILE_TYPES.END) {
                    mutatedIndividual.set(x, y, currentTile === TILE_TYPES.EMPTY ? TILE_TYPES.WALL : TILE_TYPES.EMPTY);
                } else {
                    mutatedIndividual.set(x, y, currentTile);
                }
            }
        }
        return mutatedIndividual; 
    }

    // Mutate an individual
    mutate(individual, mutationRate = 0.01) {
        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                if (Math.random() < mutationRate) {
                    const currentTile = individual.get(x, y);
                    // Avoid mutating start/end tiles
                    if (currentTile !== TILE_TYPES.START && currentTile !== TILE_TYPES.END) {
                        // Flip between floor and wall
                        individual.set(x, y, currentTile === TILE_TYPES.FLOOR ? TILE_TYPES.WALL : TILE_TYPES.FLOOR);
                    }
                }
            }
        }
    }

    // Get the best individual from the current population
    getBestIndividual() {
        return this.population[0];
    }
}

export default SGA;
