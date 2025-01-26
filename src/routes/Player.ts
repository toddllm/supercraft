import * as THREE from 'three';
import { 
    PLAYER_HEIGHT,
    MOVEMENT_SPEED,
    GRAVITY,
    PLAYER_RADIUS,
    GROUND_OFFSET
} from './GameConstants';  // Import individual constants
import type { Level } from './Level';

interface GameContext {
    level?: Level;
}

export class Player {
    public position: THREE.Vector3;
    public velocity: THREE.Vector3;
    public verticalVelocity: number = 0;
    public isGrounded: boolean = false;
    public health: number = 100;
    private readonly EYE_HEIGHT = PLAYER_HEIGHT - 0.2; // Slightly below player height

    constructor(public game: { level?: Level }) {
        console.log('Initializing player');
        this.position = new THREE.Vector3(0, 20, 0); // Start higher for better visibility
        this.velocity = new THREE.Vector3();
        console.log('Player initialized with position:', this.position);
    }

    update(delta: number) {
        if (!this.position) return;

        // Store previous position for collision resolution
        const previousPosition = this.position.clone();

        // Apply gravity if not grounded
        if (!this.isGrounded) {
            this.verticalVelocity -= GRAVITY * delta;
        }
        
        // Update vertical position
        this.position.y += this.verticalVelocity * delta;

        // Ground check
        const groundY = this.findGroundHeight();
        if (this.position.y < groundY + PLAYER_HEIGHT) {
            this.position.y = groundY + PLAYER_HEIGHT;
            this.verticalVelocity = 0;
            this.isGrounded = true;
        } else {
            this.isGrounded = false;
        }
    }

    findGroundHeight(): number {
        if (!this.game.level) return 0;

        // Check a few points below the player
        const checkRadius = PLAYER_RADIUS;
        const checkPoints = [
            [0, 0],
            [checkRadius, 0],
            [-checkRadius, 0],
            [0, checkRadius],
            [0, -checkRadius]
        ];

        let maxHeight = -Infinity;
        for (const [dx, dz] of checkPoints) {
            const x = this.position.x + dx;
            const z = this.position.z + dz;
            
            // Check downward from player position
            for (let y = Math.floor(this.position.y); y >= 0; y--) {
                if (this.game.level.hasBlock(x, y, z)) {
                    maxHeight = Math.max(maxHeight, y + 1);
                    break;
                }
            }
        }

        return maxHeight === -Infinity ? 0 : maxHeight;
    }

    getPosition(): THREE.Vector3 {
        return this.position.clone();
    }
} 