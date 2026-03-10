import * as THREE from 'three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth, window.innerHeight );
document.body.appendChild( renderer.domElement );

const geometry = new THREE.BoxGeometry( 3, 0.5, 3 );
const material = new THREE.MeshBasicMaterial( { color: 0xfcba03 } );
const cube = new THREE.Mesh( geometry, material );
// Draw only the box's actual edges (no triangle diagonals).
const edges = new THREE.EdgesGeometry( geometry );
const line = new THREE.LineSegments( edges );
line.material.color.set( 0x000000 );
cube.add( line );

scene.add( cube );

camera.position.z = 5;
camera.position.y = 1;

// create a function to rotate the scene with mouse dragging
let isDragging = false;
const ROTATION_SPEED = 0.005;
const cameraUp = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
let previousMousePosition = {
    x: 0,
    y: 0
};

function onMouseDown( event ) {
    isDragging = true;
    previousMousePosition.x = event.clientX;
    previousMousePosition.y = event.clientY;
}

function onMouseUp() {
    isDragging = false;
}


function onMouseMove( event ) {
    if ( isDragging ) {
        const deltaX = event.clientX - previousMousePosition.x;
        const deltaY = event.clientY - previousMousePosition.y;

        // Scene-view style: rotate around camera up/right axes.
        cameraUp.setFromMatrixColumn( camera.matrixWorld, 1 ).normalize();
        cameraRight.setFromMatrixColumn( camera.matrixWorld, 0 ).normalize();

        cube.rotateOnWorldAxis( cameraUp, deltaX * ROTATION_SPEED );
        cube.rotateOnWorldAxis( cameraRight, deltaY * ROTATION_SPEED );

        previousMousePosition.x = event.clientX;
        previousMousePosition.y = event.clientY;
    }
}

renderer.domElement.addEventListener( 'mousedown', onMouseDown, false );
renderer.domElement.addEventListener( 'mouseup', onMouseUp, false );
renderer.domElement.addEventListener( 'mousemove', onMouseMove, false );

function animate() {
    requestAnimationFrame( animate );

    renderer.render( scene, camera );
}

animate();