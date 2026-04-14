export class Matrix {
    constructor() {
        this.width = 20;
        this.height = 20;
        this.grid = [];
        this.init();
    }

    init() {
        for (let i = 0; i < this.height; i++) {
            this.grid[i] = [];
            for (let j = 0; j < this.width; j++) {
                this.grid[i][j] = 0;
            }
        }
    }

    get(x, y) {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
            return this.grid[y][x];
        }
        return undefined;
    }

    set(x, y, value) {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
            this.grid[y][x] = value;
        }
    }
}
