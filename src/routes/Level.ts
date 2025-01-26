import * as THREE from 'three';
import type { Player } from './Player';
import { 
    CHUNK_SIZE,
    PLAYER_HEIGHT,
    RENDER_DISTANCE
} from './GameConstants';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

interface Enemy {
    type: string;
    position: THREE.Vector3;
    health: number;
    mesh: THREE.Group;
    update: (delta: number) => void;
}

interface GameContext {
    player?: Player;
}

export class Level {
    public scene: THREE.Scene;
    public portal: {
        position: THREE.Vector3;
        rotation: THREE.Euler;
        collisionRadius: number;
        mesh: THREE.Group;
    } = {
        position: new THREE.Vector3(),
        rotation: new THREE.Euler(),
        collisionRadius: 2,
        mesh: new THREE.Group()
    };
    private lastChunkX: number = Infinity;
    private lastChunkZ: number = Infinity;
    private activeChunks: Set<string>;
    public enemies: Enemy[] = [];
    public windmills: { position: THREE.Vector3; mesh: THREE.Group; collisionRadius: number; }[] = [];
    public portals: { position: THREE.Vector3; mesh: THREE.Group; }[] = [];
    public structures: THREE.Group[] = [];
    public world: Map<string, THREE.Mesh>;
    private noise: SimplexNoise;
    private lastUpdate: number = 0;
    private readonly UPDATE_INTERVAL = 100; // Reduced from 500ms for faster updates

    constructor(public game: { player?: Player }) {
        this.scene = new THREE.Scene();
        this.noise = new SimplexNoise();
        this.world = new Map();
        this.activeChunks = new Set();
        
        // Initialize scene
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        
        // Add lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(100, 100, 100);
        directionalLight.castShadow = true;
        this.scene.add(directionalLight);

        // Generate initial terrain
        this.generateInitialChunks();
    }

    generateInitialChunks() {
        // Generate chunks around origin
        for (let x = -1; x <= 1; x++) {
            for (let z = -1; z <= 1; z++) {
                this.generateChunk(x, z);
            }
        }
    }

    generateChunk(chunkX: number, chunkZ: number) {
        const chunkKey = `${chunkX},${chunkZ}`;
        if (this.activeChunks.has(chunkKey)) return;

        const startX = chunkX * CHUNK_SIZE;
        const startZ = chunkZ * CHUNK_SIZE;
        const endX = startX + CHUNK_SIZE;
        const endZ = startZ + CHUNK_SIZE;

        for (let x = startX; x < endX; x++) {
            for (let z = startZ; z < endZ; z++) {
                // Increased base height and variation
                const height = Math.floor(this.noise.noise(x / 50, z / 50) * 15 + 15);
                
                // Generate terrain
                for (let y = 0; y <= height; y++) {
                    let blockType = 2; // Dirt
                    if (y === height) blockType = 1; // Grass on top
                    if (y < height - 3) blockType = 3; // Stone below
                    this.addBlock(x, y, z, blockType);
                }
            }
        }

        this.activeChunks.add(chunkKey);
    }

    addBlock(x: number, y: number, z: number, type: number) {
        const key = `${Math.floor(x)}|${Math.floor(y)}|${Math.floor(z)}`;
        if (this.world.has(key)) return;

        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshPhongMaterial({ 
            color: type === 1 ? 0x4f7d20 : // Grass
                   type === 2 ? 0x8b7355 : // Dirt
                   0x808080 // Stone
        });

        const block = new THREE.Mesh(geometry, material);
        block.position.set(x, y, z);
        this.scene.add(block);
        this.world.set(key, block);
    }

    updateChunks() {
        if (!this.game.player) return;

        // Throttle updates
        const now = performance.now();
        if (now - this.lastUpdate < this.UPDATE_INTERVAL) return;
        this.lastUpdate = now;

        const [playerChunkX, playerChunkZ] = this.getChunkCoordinates(
            this.game.player.position.x,
            this.game.player.position.z
        );

        // Generate only nearby chunks
        for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
            for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
                this.generateChunk(playerChunkX + dx, playerChunkZ + dz);
            }
        }
    }

    updateEnemies(delta: number) {
        // Update each enemy and remove dead ones
        this.enemies = this.enemies.filter(enemy => {
            if (enemy.health <= 0) {
                this.scene.remove(enemy.mesh);
                return false;
            }
            enemy.update(delta);
            return true;
        });
    }

    spawnEnemy(type: string, position: THREE.Vector3) {
        const enemy: Enemy = {
            type,
            position: position.clone(),
            health: 100,
            mesh: new THREE.Group(),
            update: (delta: number) => {
                // Basic enemy update logic
                if (this.game.player) {
                    const direction = this.game.player.position.clone()
                        .sub(enemy.position)
                        .normalize();
                    enemy.position.add(direction.multiplyScalar(delta));
                    enemy.mesh.position.copy(enemy.position);
                }
            }
        };
        
        // Add enemy mesh to scene
        this.scene.add(enemy.mesh);
        this.enemies.push(enemy);
    }

    updateStructures(delta: number, time: number) {
        // Update enemies
        this.updateEnemies(delta);
        
        // Rotate windmill blades
        this.windmills.forEach(windmill => {
            if (windmill.mesh.children[1]) { // Blade group is the second child
                windmill.mesh.children[1].rotation.z += delta;
            }
        });
    }

    getChunkCoordinates(x: number, z: number): [number, number] {
        return [
            Math.floor(x / CHUNK_SIZE),
            Math.floor(z / CHUNK_SIZE)
        ];
    }

    hasBlock(x: number, y: number, z: number): boolean {
        const key = `${Math.floor(x)}|${Math.floor(y)}|${Math.floor(z)}`;
        return this.world.has(key);
    }

    getBlock(x: number, y: number, z: number): THREE.Mesh | undefined {
        const key = `${Math.floor(x)}|${Math.floor(y)}|${Math.floor(z)}`;
        return this.world.get(key);
    }
} 