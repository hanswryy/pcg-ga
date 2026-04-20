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
camera.position.z = 30;

const startSgaButton = document.getElementById('start-sga');
const startMgaButton = document.getElementById('start-mga');
const fitnessDisplay = document.getElementById('fitness-display');

let gridGroup = new THREE.Group();
scene.add(gridGroup);

let sga;
let mga;

startSgaButton.addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed-input').value) || 0;
    setSeed(seed);
    runSGA();
});

startMgaButton.addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed-input').value) || 0;
    setSeed(seed);
    runMGA();
});

function runSGA() {
    sga = new SGA(50);
    sga.initializePopulation();

    const generations = 2000; // Increased generations to 2000
    for (let i = 0; i < generations; i++) {
        sga.evolve();
    }

    const best = sga.getBestIndividual();
    const bestIndividual = best.individual;
    fitnessDisplay.innerText = `SGA Best Fitness: ${best.fitness}`;
 
    renderGrid(bestIndividual);
    fitnessDisplay.textContent = sga.getBestIndividual().fitness;
}

function runMGA() {
    mga = new MGA(50, 10, 10);
    mga.initializePopulation();

    const generations = 2000; // Increased generations to 2000
    for (let i = 0; i < generations; i++) {
        mga.evolve();
    }

    const best = mga.getBestIndividual();
    const bestIndividual = best.individual;
    fitnessDisplay.innerText = `MGA Best Fitness: ${best.fitness}`;

    renderGrid(bestIndividual);
    fitnessDisplay.textContent = mga.getBestIndividual().fitness;
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

function renderGrid(individual) {
    // Clear previous grid
    while(gridGroup.children.length > 0){ 
        const object = gridGroup.children[0];
        object.geometry.dispose();
        object.material.dispose();
        gridGroup.remove(object);
    }

    const geometry = new THREE.PlaneGeometry( 1, 1 );
    for (let i = 0; i < individual.height; i++) {
        for (let j = 0; j < individual.width; j++) {
            const value = individual.get(j, i);
            const color = getColorForTile(value);
            const material = new THREE.MeshBasicMaterial( { color: color } );
            const plane = new THREE.Mesh( geometry, material );
            plane.position.x = j - (individual.width / 2);
            plane.position.y = i - (individual.height / 2);
            gridGroup.add( plane );
        }
    }
}

function animate() {
    requestAnimationFrame( animate );
    renderer.render( scene, camera );
}

animate();
