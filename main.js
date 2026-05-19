import * as THREE from 'three';
import { Matrix } from './matrix.js';
import SGA, { TILE_TYPES } from './sga.js';
import MGA from './mga.js';
import { setSeed } from './seeded-random.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );
const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth, window.innerHeight );
document.body.appendChild( renderer.domElement );
camera.position.z = 50;

const startSgaButton = document.getElementById('start-sga');
const startMgaButton = document.getElementById('start-mga');
const fitnessDisplay = document.getElementById('fitness-display');

let gridGroup = new THREE.Group();
scene.add(gridGroup);

let sga;
let mga;

startSgaButton.addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed-input').value) || 0;
    runSGA(seed);
});

startMgaButton.addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed-input').value) || 0;
    runMGA(seed);
});

function createHeapRecorder(sampleEvery = 100) {
    const samples = [];
    const canMeasure = typeof performance !== 'undefined' &&
        performance.memory &&
        typeof performance.memory.usedJSHeapSize === 'number';

    function record(generation) {
        if (!canMeasure || generation % sampleEvery !== 0) {
            return;
        }

        samples.push({
            generation,
            usedJSHeapSize: performance.memory.usedJSHeapSize,
        });
    }

    function getMean() {
        if (samples.length === 0) {
            return 0;
        }

        const total = samples.reduce((sum, sample) => sum + sample.usedJSHeapSize, 0);
        return total / samples.length;
    }

    return {
        record,
        getReport() {
            return {
                canMeasure,
                sampleEvery,
                samples,
                meanUsedHeapSize: getMean(),
            };
        },
    };
}

function formatBytesToMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2);
}

function updateExperimentDisplay(algorithmName, fitness, report) {
    if (!report.canMeasure || report.samples.length === 0) {
        fitnessDisplay.textContent = `${algorithmName} Best Fitness: ${fitness} | Mean Heap: N/A (performance.memory not available)`;
        return;
    }

    fitnessDisplay.textContent = `${algorithmName} Best Fitness: ${fitness} | Mean Heap: ${formatBytesToMB(report.meanUsedHeapSize)} MB (${Math.round(report.meanUsedHeapSize)} bytes) | Samples: ${report.samples.length}`;
}

const LEVEL_COUNT = 5;

function runSGA(baseSeed) {
    const individuals = [];
    let totalHeapReport = null;

    for (let s = 0; s < LEVEL_COUNT; s++) {
        setSeed(baseSeed + s);
        sga = new SGA(50);
        sga.initializePopulation();
        const heapRecorder = createHeapRecorder(100);

        const generations = 2000;
        for (let i = 0; i < generations; i++) {
            sga.evolve();
            heapRecorder.record(i + 1);
        }

        if (s === 0) totalHeapReport = heapRecorder.getReport();

        const best = sga.getBestIndividual();
        individuals.push(best);
        console.log(`[SGA] seed=${baseSeed + s} fitness=${best.fitness}`);
    }

    if (totalHeapReport.canMeasure) {
        console.log(`[SGA] Mean usedJSHeapSize: ${Math.round(totalHeapReport.meanUsedHeapSize)} bytes`);
    } else {
        console.warn('[SGA] performance.memory.usedJSHeapSize is not available in this browser.');
    }

    const avgFitness = (individuals.reduce((sum, b) => sum + b.fitness, 0) / LEVEL_COUNT).toFixed(4);
    updateExperimentDisplay('SGA', avgFitness, totalHeapReport);
    renderMultipleGrids(individuals.map(b => b.individual));
}

function runMGA(baseSeed) {
    const individuals = [];
    let totalHeapReport = null;

    for (let s = 0; s < LEVEL_COUNT; s++) {
        setSeed(baseSeed + s);
        mga = new MGA(50);
        mga.initializePopulation();
        const heapRecorder = createHeapRecorder(100);

        const generations = 2000;
        for (let i = 0; i < generations; i++) {
            mga.evolve();
            heapRecorder.record(i + 1);
        }

        if (s === 0) totalHeapReport = heapRecorder.getReport();

        const best = mga.getBestIndividual();
        individuals.push(best);
        console.log(`[MGA] seed=${baseSeed + s} fitness=${best.fitness}`);
    }

    if (totalHeapReport.canMeasure) {
        console.log(`[MGA] Mean usedJSHeapSize: ${Math.round(totalHeapReport.meanUsedHeapSize)} bytes`);
    } else {
        console.warn('[MGA] performance.memory.usedJSHeapSize is not available in this browser.');
    }

    const avgFitness = (individuals.reduce((sum, b) => sum + b.fitness, 0) / LEVEL_COUNT).toFixed(4);
    updateExperimentDisplay('MGA', avgFitness, totalHeapReport);
    renderMultipleGrids(individuals.map(b => b.individual));
}

function getColorForTile(tileType) {
    switch (tileType) {
        case TILE_TYPES.EMPTY:
            return 0xffffff; // white
        case TILE_TYPES.WALL:
            return 0x808080; // grey
        case TILE_TYPES.HAZARD:
            return 0xff0000; // red
        case TILE_TYPES.ITEM:
            return 0xffff00; // yellow
        case TILE_TYPES.START:
            return 0x00ff00; // green
        case TILE_TYPES.END:
            return 0x0000ff; // blue
        default:
            return 0x000000; // black
    }
}

function renderMultipleGrids(individuals) {
    while (gridGroup.children.length > 0) {
        const object = gridGroup.children[0];
        object.geometry.dispose();
        object.material.dispose();
        gridGroup.remove(object);
    }

    const geometry = new THREE.PlaneGeometry(1, 1);
    const gap = 2;

    const totalWidth = individuals.reduce((sum, ind) => sum + ind.width, 0) + gap * (individuals.length - 1);
    let offsetX = -totalWidth / 2;

    for (const individual of individuals) {
        for (let i = 0; i < individual.height; i++) {
            for (let j = 0; j < individual.width; j++) {
                const value = individual.get(j, i);
                const color = getColorForTile(value);
                const material = new THREE.MeshBasicMaterial({ color });
                const plane = new THREE.Mesh(geometry, material);
                plane.position.x = offsetX + j + 0.5;
                plane.position.y = i - individual.height / 2;
                gridGroup.add(plane);
            }
        }
        offsetX += individual.width + gap;
    }
}

function animate() {
    requestAnimationFrame( animate );
    renderer.render( scene, camera );
}

animate();
