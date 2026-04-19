// a-star.js

class Node {
    constructor(x, y, parent = null) {
        this.x = x;
        this.y = y;
        this.parent = parent;
        this.g = 0; // Cost from start to current node
        this.h = 0; // Heuristic cost from current node to end
        this.f = 0; // Total cost (g + h)
    }
}

export function aStar(grid, start, end) {
    const openList = [];
    const closedList = new Set();

    const startNode = new Node(start.x, start.y);
    const endNode = new Node(end.x, end.y);

    openList.push(startNode);

    while (openList.length > 0) {
        // Get the node with the lowest f cost
        let currentNode = openList[0];
        let currentIndex = 0;
        for (let i = 1; i < openList.length; i++) {
            if (openList[i].f < currentNode.f) {
                currentNode = openList[i];
                currentIndex = i;
            }
        }

        // Move current node from open to closed list
        openList.splice(currentIndex, 1);
        closedList.add(`${currentNode.x}-${currentNode.y}`);

        // Found the path
        if (currentNode.x === endNode.x && currentNode.y === endNode.y) {
            return true; // Path found
        }

        // Get neighbors
        const neighbors = [];
        const { x, y } = currentNode;
        if (x > 0) neighbors.push(new Node(x - 1, y, currentNode));
        if (x < grid.width - 1) neighbors.push(new Node(x + 1, y, currentNode));
        if (y > 0) neighbors.push(new Node(x, y - 1, currentNode));
        if (y < grid.height - 1) neighbors.push(new Node(x, y + 1, currentNode));

        for (const neighbor of neighbors) {
            const neighborId = `${neighbor.x}-${neighbor.y}`;
            if (closedList.has(neighborId)) {
                continue;
            }

            const tile = grid.get(neighbor.x, neighbor.y);
            if (tile === 3) { // TILE_TYPES.WALL
                continue;
            }

            neighbor.g = currentNode.g + 1;
            neighbor.h = Math.abs(neighbor.x - endNode.x) + Math.abs(neighbor.y - endNode.y); // Manhattan distance
            neighbor.f = neighbor.g + neighbor.h;

            let inOpenList = false;
            for (const openNode of openList) {
                if (neighbor.x === openNode.x && neighbor.y === openNode.y && neighbor.g >= openNode.g) {
                    inOpenList = true;
                    break;
                }
            }

            if (!inOpenList) {
                openList.push(neighbor);
            }
        }
    }

    return false; // No path found
}
