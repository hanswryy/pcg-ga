import { Matrix } from './matrix.js';
import { aStar } from './a-star.js';

// Tile types
export const TILE_TYPES = {
    EMPTY: 0,
    FLOOR: 1,
    WALL: 2,
    HAZARD: 3,
    ITEM: 4,
    START: 5,
    END: 6,
};

class SGA {
    constructor(populationSize = 50) {
        this.populationSize = populationSize;
        this.population = [];
        this.evolutionHistory = [];
        this.generation = 0;
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
                const rand = Math.random();
                if (rand < 0.5) {
                    individual.set(x, y, TILE_TYPES.FLOOR);
                } else {
                    individual.set(x, y, TILE_TYPES.WALL);
                }
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
        for (const pop of this.population) {
            pop.fitness = this.calculateFitness(pop.individual);
        }
        // Sort population by fitness in descending order
        this.population.sort((a, b) => b.fitness - a.fitness);
    }

    // Calculate fitness for a single individual
    calculateFitness(individual) {
        let startPos, endPos;
        let wallCount = 0;
        let floorCount = 0;

        for (let y = 0; y < individual.height; y++) {
            for (let x = 0; x < individual.width; x++) {
                const tile = individual.get(x, y);
                if (tile === TILE_TYPES.START) startPos = { x, y };
                if (tile === TILE_TYPES.END) endPos = { x, y };
                if (tile === TILE_TYPES.WALL) wallCount++;
                if (tile === TILE_TYPES.FLOOR) floorCount++;
            }
        }

        const c1 = startPos ? 1 : 0;
        const c2 = endPos ? 1 : 0;
        
        // Placeholder for A* pathfinding
        const c3 = this.hasPath(individual, startPos, endPos) ? 1 : 0; 

        // Density (e) - balance between walkable area and walls
        const totalTiles = individual.width * individual.height;
        const e = 1 - Math.abs((floorCount - wallCount) / totalTiles);

        // Start-end distance (d) - Euclidean distance
        const d = startPos && endPos ? Math.sqrt(Math.pow(endPos.x - startPos.x, 2) + Math.pow(endPos.y - startPos.y, 2)) : 0;
        const maxDist = Math.sqrt(Math.pow(individual.width - 1, 2) + Math.pow(individual.height - 1, 2));
        const normalized_d = d / maxDist;

        const F_total = (c1 * c2 * c3) * (0.5 * e + 0.5 * normalized_d);
        return F_total;
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
                    mutatedIndividual.set(x, y, currentTile === TILE_TYPES.FLOOR ? TILE_TYPES.WALL : TILE_TYPES.FLOOR);
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
