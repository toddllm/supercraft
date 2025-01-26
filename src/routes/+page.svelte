<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as THREE from 'three';
    import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
    import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
    import { browser } from '$app/environment';
    import { Level } from './Level';
    import { Player } from './Player';
    import { 
        BLOCK_SIZE,
        RENDER_DISTANCE,
        CHUNK_SIZE,
        BREAK_DISTANCE,
        INVENTORY_SIZE,
        HOTBAR_SIZE,
        DAY_LENGTH,
        MOVEMENT_SPEED,
        GRAVITY,
        JUMP_FORCE,
        PLAYER_HEIGHT,
        PLAYER_RADIUS,
        GROUND_OFFSET
    } from './GameConstants';
  
    let canvas: HTMLCanvasElement;
    const world = new Map<string, THREE.Mesh>();
    
    // Day/night cycle
    let timeOfDay = 0; // 0-1 where 0=dawn, 0.5=dusk
    let isNight = false;
    let sunLight: THREE.DirectionalLight | null = null;
    let moonLight: THREE.DirectionalLight | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene;
    let camera: THREE.PerspectiveCamera;
    let controls: PointerLockControls;
    let raycaster = new THREE.Raycaster();
    let selectedBlock: THREE.Vector3 | null = null;
    let currentBlockType = 1;
    let inventory = Array(INVENTORY_SIZE).fill({ type: 0, count: 0 });
    let selectedSlot = 0;
    let breakingProgress = 0;
    let currentBreakingBlock: THREE.Vector3 | null = null;

    // Update block selection based on inventory
    $: currentBlockType = inventory[selectedSlot]?.type || 0;

    function addToInventory(type: number, count = 1) {
        const existing = inventory.findIndex(slot => slot.type === type);
        if (existing > -1) {
            inventory[existing].count += count;
        } else {
            const firstEmpty = inventory.findIndex(slot => slot.type === 0);
            if (firstEmpty > -1) {
                inventory[firstEmpty] = { type, count };
            }
        }
        inventory = inventory; // Trigger Svelte reactivity
    }

    // Block colors [air, grass, dirt, stone, wood, leaves, sand, iron, gold, emerald]
    const blockColors = [
      null,
      { top: '#4f7d20', side: '#6b8c42', bottom: '#8b7355' }, // Grass
      { top: '#8b7355', side: '#8b7355', bottom: '#8b7355' }, // Dirt
      { top: '#808080', side: '#808080', bottom: '#808080' }, // Stone
      { top: '#8b5a2b', side: '#8b5a2b', bottom: '#8b5a2b' }, // Wood (log)
      { top: '#317f43', side: '#317f43', bottom: '#317f43' }, // Leaves
      { top: '#d9b382', side: '#d9b382', bottom: '#d9b382' }, // Sand
      { top: '#656565', side: '#656565', bottom: '#656565' }, // Iron Ore
      { top: '#FFD700', side: '#FFD700', bottom: '#FFD700' }, // Gold Ore
      { top: '#00FF00', side: '#00FF00', bottom: '#00FF00' }, // Emerald Ore
    ];
  
    // Debug state
    let debugLastPrint = 0;
    const DEBUG_INTERVAL = 1000;
    
    // Make keys reactive
    let keys: { [key: string]: boolean } = {};
    $: console.log('Keys state changed:', keys);
  
    let isControlsLocked = false;
  
    // World generation
    const noise = new SimplexNoise();
    let lastChunkX = Infinity;
    let lastChunkZ = Infinity;
    const activeChunks = new Set<string>();
  
    // Movement handling
    const geometryPool = new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
    const materialCache = new Map<string, THREE.MeshBasicMaterial>();
  
    function getMaterial(color: string): THREE.MeshBasicMaterial {
      if (!materialCache.has(color)) {
        materialCache.set(color, new THREE.MeshBasicMaterial({ color }));
      }
      return materialCache.get(color)!;
    }
  
    function getChunkCoordinates(x: number, z: number): [number, number] {
      return [
        Math.floor(x / CHUNK_SIZE),
        Math.floor(z / CHUNK_SIZE)
      ];
    }
  
    function generateChunk(chunkX: number, chunkZ: number) {
      const chunkKey = `${chunkX},${chunkZ}`;
      if (activeChunks.has(chunkKey)) {
        console.log(`Skipping existing chunk: ${chunkKey}`);
        return;
      }
      
      console.log(`Generating chunk: ${chunkKey}`);
      
      // Only generate if within render distance
      const [currentChunkX, currentChunkZ] = getChunkCoordinates(player.position.x, player.position.z);
      if (Math.abs(chunkX - currentChunkX) > RENDER_DISTANCE || 
          Math.abs(chunkZ - currentChunkZ) > RENDER_DISTANCE) {
        console.log(`Chunk ${chunkKey} outside render distance, skipping`);
        return;
      }
      
      activeChunks.add(chunkKey);
      console.log(`Active chunks: ${activeChunks.size}`);
  
      // Calculate chunk boundaries
      const startX = chunkX * CHUNK_SIZE;
      const startZ = chunkZ * CHUNK_SIZE;
      const endX = startX + CHUNK_SIZE;
      const endZ = startZ + CHUNK_SIZE;
  
      // Generate terrain more efficiently
      for (let wx = startX; wx < endX; wx++) {
        for (let wz = startZ; wz < endZ; wz++) {
          // Only calculate height once per column
          const height = Math.floor(noise.noise(wx / 30, wz / 30) * 8 + 32);
          
          // Start from the top and only generate visible blocks
          addBlock(wx, height, wz, 1); // Grass
          for (let y = height - 1; y > height - 4 && y > 0; y--) {
            addBlock(wx, y, wz, 2); // Dirt
          }
          // Only add stone near the surface
          for (let y = Math.max(0, height - 4); y > Math.max(0, height - 8); y--) {
            addBlock(wx, y, wz, 3); // Stone
          }
        }
      }
    }
  
    function updateChunks() {
      const [currentChunkX, currentChunkZ] = getChunkCoordinates(
        player.position.x,
        player.position.z
      );
  
      if (currentChunkX === lastChunkX && currentChunkZ === lastChunkZ) return;
  
      // Generate chunks in a spiral pattern, starting from the center
      const chunksToGenerate: [number, number][] = [];
      for (let d = 0; d <= RENDER_DISTANCE; d++) {
        for (let x = -d; x <= d; x++) {
          for (let z = -d; z <= d; z++) {
            if (Math.max(Math.abs(x), Math.abs(z)) === d) {
              chunksToGenerate.push([currentChunkX + x, currentChunkZ + z]);
            }
          }
        }
      }
  
      // Generate chunks gradually
      const chunksPerFrame = 2;
      for (let i = 0; i < Math.min(chunksPerFrame, chunksToGenerate.length); i++) {
        const [x, z] = chunksToGenerate[i];
        generateChunk(x, z);
      }
  
      // Remove far chunks
      const toRemove: string[] = [];
      activeChunks.forEach(key => {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        if (Math.abs(chunkX - currentChunkX) > RENDER_DISTANCE ||
            Math.abs(chunkZ - currentChunkZ) > RENDER_DISTANCE) {
          toRemove.push(key);
        }
      });
  
      toRemove.forEach(key => {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        for (let x = 0; x < CHUNK_SIZE; x++) {
          for (let z = 0; z < CHUNK_SIZE; z++) {
            const wx = chunkX * CHUNK_SIZE + x;
            const wz = chunkZ * CHUNK_SIZE + z;
            // Only remove visible blocks
            for (let y = 0; y < 40; y++) {
              removeBlock(new THREE.Vector3(wx, y, wz));
            }
          }
        }
        activeChunks.delete(key);
      });
  
      lastChunkX = currentChunkX;
      lastChunkZ = currentChunkZ;
    }
  
    // Define block color type
    type BlockColor = {
        top: string;
        side: string;
        bottom: string;
    };

    function addBlock(x: number, y: number, z: number, type: number) {
      if (type === 0) return;
      const key = `${x}|${y}|${z}`;
      if (world.has(key)) return;
  
      const colors = blockColors[type] as BlockColor;
      if (!colors) return;

      const materials = [
        getMaterial(colors.side),
        getMaterial(colors.side),
        getMaterial(colors.top),
        getMaterial(colors.bottom),
        getMaterial(colors.side),
        getMaterial(colors.side),
      ];
  
      const block = new THREE.Mesh(geometryPool, materials);
      block.position.set(x, y, z);
      scene.add(block);
      world.set(key, block);
    }
  
    function generateTree(x: number, y: number, z: number) {
        // Trunk (4 blocks tall)
        for(let ty = y; ty < y + 4; ty++) {
            addBlock(x, ty, z, 4); // Wood blocks
        }
        
        // Leaves
        const leafRadius = 2;
        for(let lx = x - leafRadius; lx <= x + leafRadius; lx++) {
            for(let lz = z - leafRadius; lz <= z + leafRadius; lz++) {
                for(let ly = y + 2; ly < y + 5; ly++) {
                    if(Math.random() < 0.7 && (lx !== x || lz !== z || ly > y + 3)) {
                        addBlock(lx, ly, lz, 5); // Leaves
                    }
                }
            }
        }
    }

    function removeBlock(pos: THREE.Vector3) {
        const key = `${Math.floor(pos.x)}|${Math.floor(pos.y)}|${Math.floor(pos.z)}`;
        const block = world.get(key);
        if (block) {
            // Get block type from the block's material color
            const blockMaterial = block.material as THREE.MeshBasicMaterial[];
            const topColor = blockMaterial[2].color.getHexString();
            const type = blockColors.findIndex(color => 
                color && color.top.replace('#', '').toLowerCase() === topColor
            );
            
            if (type > 0) {
                addToInventory(type, 1);
            }
            scene.remove(block);
            world.delete(key);
        }
    }
  
    function updateSelectedBlock() {
      raycaster.setFromCamera(new THREE.Vector2(), camera);
      const intersects = raycaster.intersectObjects(Array.from(world.values()));
      
      if (intersects.length > 0) {
        const point = intersects[0].point;
        const face = intersects[0].face;
        const normal = intersects[0].face?.normal;
        
        if (face && normal) {
          selectedBlock = new THREE.Vector3(
            Math.floor(point.x + normal.x * 0.5),
            Math.floor(point.y + normal.y * 0.5),
            Math.floor(point.z + normal.z * 0.5)
          );
        }
      } else {
        selectedBlock = null;
      }
    }
  
    // Add collision detection helpers
    function getBlock(x: number, y: number, z: number): any {
        const key = `${Math.floor(x)}|${Math.floor(y)}|${Math.floor(z)}`;
        const block = world.get(key);
        if (block) {
            console.log('Found block at:', key);
        }
        return block;
    }
  
    // Update the checkCollision function
    function checkCollision(position: THREE.Vector3): boolean {
        if (!level) return false;

        // Check blocks around player
        const radius = PLAYER_RADIUS;
        const height = PLAYER_HEIGHT;
        
        // Check points around the player's body
        const checkPoints = [
            // Center line
            [0, 0],
            // Corners
            [radius, radius],
            [radius, -radius],
            [-radius, radius],
            [-radius, -radius]
        ];

        // Check each point at different heights
        const heightChecks = [0, height/2, height];

        for (const [dx, dz] of checkPoints) {
            const x = position.x + dx;
            const z = position.z + dz;
            
            for (const dy of heightChecks) {
                const y = position.y + dy - height;
                if (level.hasBlock(x, y, z)) {
                    return true;
                }
            }
        }

        return false;
    }
  
    // Game state variables
    let lastTime = performance.now();
    let lastEnemySpawn = performance.now();
    let gameTime = 0;  // Add gameTime variable
    let player: Player | null = null;
    let level: Level | null = null;
    let isInitialized = false;
    let isPaused = false;
    let showPauseMenu = false;
    let gameStarted = false;

    function initializeGame() {
        const game: { player?: Player; level?: Level } = {};
        
        // Initialize renderer
        renderer = new THREE.WebGLRenderer({ 
            canvas,
            antialias: true,
            alpha: false
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setClearColor(0x87CEEB);
        renderer.shadowMap.enabled = true;
        
        // Initialize level first
        level = new Level(game);
        game.level = level;
        scene = level.scene;
        
        // Initialize player
        player = new Player(game);
        game.player = player;
        
        // Initialize camera
        camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
        camera.position.copy(player.position);
        camera.position.y += PLAYER_HEIGHT;
        
        // Initialize controls
        controls = new PointerLockControls(camera, canvas);
        controls.object.position.copy(player.position);
        scene.add(controls.object);
        
        // Generate initial chunks
        level.updateChunks();
        
        isInitialized = true;
        console.log('Game initialized successfully');
    }

    function spawnInitialEnemies() {
        for (let i = 0; i < 5; i++) {
            spawnEnemy();
        }
    }

    let videoElement: HTMLVideoElement;
    let rendererInitialized = false;

    function animate(time: number) {
        requestAnimationFrame(animate);
        
        if (!isInitialized || !player || !level || !renderer || !scene || !camera) {
            return;
        }

        try {
            const currentTime = performance.now();
            const delta = Math.min((currentTime - lastTime) / 1000, 0.1);
            lastTime = currentTime;
            
            if (!isPaused && isControlsLocked) {
                // Update player
                player.update(delta);
                
                // Update camera position
                controls.object.position.copy(player.position);
                controls.object.position.y += PLAYER_HEIGHT;
                
                // Update level
                level.updateChunks();
                
                // Handle movement
                if (keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD'] || keys['Space']) {
                    updatePlayerPosition(delta);
                }
            }

            renderer.render(scene, camera);
        } catch (error) {
            console.error('Error in animation loop:', error);
        }
    }

    function onWindowResize() {
        if (camera) {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
        }
        if (renderer) {
            renderer.setSize(window.innerWidth, window.innerHeight);
        }
    }

    // Attack function
    function attackEnemies() {
        if (!controls || !player) return;

        // Get direction player is facing
        const cameraDirection = new THREE.Vector3();
        controls.object.getWorldDirection(cameraDirection);

        // Create raycaster for attack detection
        const attackRaycaster = new THREE.Raycaster(
            player.position,
            cameraDirection,
            0,
            5 // Attack range of 5 units
        );

        // Get enemy meshes
        const enemyMeshes = enemies.map(enemy => enemy.mesh);
        
        // Check for hits
        const hits = attackRaycaster.intersectObjects(enemyMeshes, true);
        
        if (hits.length > 0) {
            // Find the enemy that was hit
            const hitMesh = hits[0].object;
            const hitEnemy = enemies.find(enemy => 
                enemy.mesh === hitMesh || enemy.mesh.children.includes(hitMesh)
            );
            
            if (hitEnemy) {
                hitEnemy.takeDamage(25); // Player does 25 damage per hit
                
                // Visual feedback - flash enemy red
                const bodyMesh = hitEnemy.mesh.children[0] as THREE.Mesh;
                const materials = bodyMesh.material as THREE.Material | THREE.Material[];
                
                // Store original colors
                const originalColors = Array.isArray(materials) 
                    ? materials.map(m => (m as THREE.MeshPhongMaterial).color.clone())
                    : [(materials as THREE.MeshPhongMaterial).color.clone()];
                
                // Flash red
                if (Array.isArray(materials)) {
                    materials.forEach(m => (m as THREE.MeshPhongMaterial).color.setHex(0xff0000));
                } else {
                    (materials as THREE.MeshPhongMaterial).color.setHex(0xff0000);
                }
                
                // Reset color after 100ms
                setTimeout(() => {
                    if (Array.isArray(materials)) {
                        materials.forEach((m, i) => (m as THREE.MeshPhongMaterial).color.copy(originalColors[i]));
                    } else {
                        (materials as THREE.MeshPhongMaterial).color.copy(originalColors[0]);
                    }
                }, 100);
            }
        }
    }

    // Resume game function
    function resumeGame() {
        // Request pointer lock on next tick to avoid event conflicts
        setTimeout(() => {
            canvas.requestPointerLock().catch(error => {
                console.error('Failed to request pointer lock:', error);
            });
        }, 0);
    }

    function createWindmill(position: THREE.Vector3) {
        const windmill = new THREE.Group();
        
        // Base/Tower
        const tower = new THREE.Mesh(
            new THREE.CylinderGeometry(2, 3, 15, 8),
            new THREE.MeshPhongMaterial({ color: 0x8B4513 })
        );
        
        // Blades
        const blades = new THREE.Group();
        for (let i = 0; i < 4; i++) {
            const blade = new THREE.Mesh(
                new THREE.BoxGeometry(1, 8, 0.2),
                new THREE.MeshPhongMaterial({ color: 0x8B4513 })
            );
            blade.rotation.z = (Math.PI / 2) * i;
            blades.add(blade);
        }
        blades.position.y = 8;
        
        windmill.add(tower, blades);
        windmill.position.copy(position);
        return { mesh: windmill, blades };
    }

    function createCastle(position: THREE.Vector3) {
        const castle = new THREE.Group();
        
        // Main keep
        const keep = new THREE.Mesh(
            new THREE.BoxGeometry(20, 30, 20),
            new THREE.MeshPhongMaterial({ color: 0x808080 })
        );
        
        // Towers
        const towerGeometry = new THREE.CylinderGeometry(3, 3, 35, 8);
        const towerMaterial = new THREE.MeshPhongMaterial({ color: 0x707070 });
        
        const positions = [
            [-12, 0, -12],
            [12, 0, -12],
            [-12, 0, 12],
            [12, 0, 12]
        ];
        
        positions.forEach(([x, y, z]) => {
            const tower = new THREE.Mesh(towerGeometry, towerMaterial);
            tower.position.set(x, y, z);
            castle.add(tower);
            
            // Add cone roof to tower
            const roof = new THREE.Mesh(
                new THREE.ConeGeometry(3.5, 5, 8),
                new THREE.MeshPhongMaterial({ color: 0x800000 })
            );
            roof.position.set(x, y + 20, z);
            castle.add(roof);
        });
        
        castle.add(keep);
        castle.position.copy(position);
        return castle;
    }

    function createPortal(position: THREE.Vector3) {
        const portal = new THREE.Group();
        
        // Make portal larger
        const frame = new THREE.Mesh(
            new THREE.TorusGeometry(3, 0.5, 16, 32),
            new THREE.MeshPhongMaterial({ 
                color: 0x4169E1,
                emissive: 0x000066
            })
        );
        
        const innerRing = new THREE.Mesh(
            new THREE.TorusGeometry(2.5, 0.2, 16, 32),
            new THREE.MeshPhongMaterial({ 
                color: 0x00BFFF,
                emissive: 0x00BFFF,
                transparent: true,
                opacity: 0.7
            })
        );

        // Add portal effect
        const particles = new THREE.Points(
            new THREE.BufferGeometry(),
            new THREE.PointsMaterial({
                color: 0x00BFFF,
                size: 0.1,
                transparent: true,
                opacity: 0.6
            })
        );

        // Create particle positions
        const particlePositions = [];
        for (let i = 0; i < 1000; i++) {
            const theta = Math.random() * Math.PI * 2;
            const radius = Math.random() * 2.5;
            particlePositions.push(
                Math.cos(theta) * radius,
                Math.random() * 6 - 3,
                Math.sin(theta) * radius
            );
        }
        particles.geometry.setAttribute('position', 
            new THREE.Float32BufferAttribute(particlePositions, 3)
        );
        
        portal.add(frame, innerRing, particles);
        portal.position.copy(position);
        
        // Keep portal vertical
        portal.rotation.x = Math.PI / 2;

        return { 
            mesh: portal, 
            innerRing, 
            particles,
            position: position.clone(), // Store original position
            destination: new THREE.Vector3(
                Math.random() * 200 - 100,
                50, // Higher teleport point
                Math.random() * 200 - 100
            )
        };
    }

    function createCave(position: THREE.Vector3) {
        const cave = new THREE.Group();
        
        // Cave entrance
        const entrance = new THREE.Mesh(
            new THREE.CylinderGeometry(5, 5, 10, 32, 1, true, 0, Math.PI),
            new THREE.MeshPhongMaterial({ 
                color: 0x463E3F,
                side: THREE.DoubleSide
            })
        );
        
        // Add some rocks around entrance
        for (let i = 0; i < 8; i++) {
            const rock = new THREE.Mesh(
                new THREE.DodecahedronGeometry(Math.random() * 2 + 1),
                new THREE.MeshPhongMaterial({ color: 0x463E3F })
            );
            const angle = (i / 8) * Math.PI;
            rock.position.set(
                Math.cos(angle) * 6,
                -2,
                Math.sin(angle) * 6
            );
            cave.add(rock);
        }
        
        cave.add(entrance);
        cave.position.copy(position);
        return cave;
    }

    // Add these variables to your game state
    const windmills: { mesh: THREE.Group, blades: THREE.Group }[] = [];
    const portals: { mesh: THREE.Group, innerRing: THREE.Mesh, particles: THREE.Points, position: THREE.Vector3, destination: THREE.Vector3 }[] = [];
    let coins: THREE.Mesh[] = [];
    const flags: THREE.Group[] = [];

    // Add at the top with other state variables
    let castle: THREE.Group;
    let cave: THREE.Group;

    // Then modify addStructures()
    function addStructures() {
        // Add windmills
        for (let i = 0; i < 3; i++) {
            const position = new THREE.Vector3(
                Math.random() * 100 - 50,
                0,
                Math.random() * 100 - 50
            );
            const windmill = createWindmill(position);
            windmills.push(windmill);
            scene.add(windmill.mesh);
        }
        
        // Add castle
        castle = createCastle(new THREE.Vector3(0, 0, -50));
        scene.add(castle);
        
        // Add portal in a clear, elevated position
        const portal = createPortal(new THREE.Vector3(30, 3, 30));
        portals.push(portal);
        scene.add(portal.mesh);
        
        // Add cave
        cave = createCave(new THREE.Vector3(-30, 0, -30));
        scene.add(cave);
        
        // Add coins
        for (let i = 0; i < 20; i++) {
            const coin = new THREE.Mesh(
                new THREE.CylinderGeometry(0.5, 0.5, 0.1, 32),
                new THREE.MeshPhongMaterial({ 
                    color: 0xFFD700,
                    emissive: 0x332200
                })
            );
            coin.position.set(
                Math.random() * 100 - 50,
                1,
                Math.random() * 100 - 50
            );
            coins.push(coin);
            scene.add(coin);
        }
        
        // Add flags
        for (let i = 0; i < 5; i++) {
            const flag = new THREE.Group();
            
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.1, 0.1, 10, 8),
                new THREE.MeshPhongMaterial({ color: 0x8B4513 })
            );
            
            const cloth = new THREE.Mesh(
                new THREE.PlaneGeometry(2, 1),
                new THREE.MeshPhongMaterial({ 
                    color: 0xFF0000,
                    side: THREE.DoubleSide
                })
            );
            cloth.position.set(1, 4, 0);
            
            flag.add(pole, cloth);
            flag.position.set(
                Math.random() * 100 - 50,
                0,
                Math.random() * 100 - 50
            );
            flags.push(flag);
            scene.add(flag);
        }
    }

    // Update player movement function
    function updatePlayerPosition(delta: number) {
        if (!player || !controls) return;

        const moveDirection = new THREE.Vector3();
        const cameraDirection = new THREE.Vector3();
        controls.object.getWorldDirection(cameraDirection);
        
        // Get forward and right vectors from camera
        const forward = new THREE.Vector3(cameraDirection.x, 0, cameraDirection.z).normalize();
        const right = new THREE.Vector3(forward.z, 0, -forward.x);
        
        // Calculate movement based on keys
        if (keys['KeyW']) moveDirection.add(forward);
        if (keys['KeyS']) moveDirection.sub(forward);
        if (keys['KeyD']) moveDirection.add(right);
        if (keys['KeyA']) moveDirection.sub(right);
        
        // Handle jumping
        if (keys['Space'] && player.isGrounded) {
            player.verticalVelocity = JUMP_FORCE;
            player.isGrounded = false;
        }

        // Apply movement if there is any
        if (moveDirection.length() > 0) {
            moveDirection.normalize();
            moveDirection.multiplyScalar(MOVEMENT_SPEED * delta);
            
            // Try to move on X and Z axes separately
            const newPosition = player.position.clone();
            
            // Try X movement
            newPosition.x += moveDirection.x;
            if (!checkCollision(newPosition)) {
                player.position.x = newPosition.x;
            }
            
            // Try Z movement
            newPosition.z += moveDirection.z;
            if (!checkCollision(newPosition)) {
                player.position.z = newPosition.z;
            }
        }

        // Update player physics
        player.update(delta);

        // Update camera position
        controls.object.position.copy(player.position);
        controls.object.position.y += PLAYER_HEIGHT;
    }

    // Update the checkPortals function
    function checkPortals() {
        portals.forEach(portal => {
            // Calculate distance to portal center
            const distanceToPortal = player.position.distanceTo(portal.position);
            
            if (distanceToPortal < 3) { // Increased detection radius
                console.log("Player near portal, teleporting!");
                // Teleport player
                player.position.copy(portal.destination);
                controls.object.position.copy(player.position);
                controls.object.position.y += PLAYER_HEIGHT - 0.2;
                
                // Reset vertical velocity for a controlled fall
                player.verticalVelocity = 0;
                player.isGrounded = false;

                // Add teleport effect
                const teleportEffect = new THREE.Points(
                    new THREE.BufferGeometry(),
                    new THREE.PointsMaterial({
                        color: 0x00BFFF,
                        size: 0.2,
                        transparent: true,
                        opacity: 0.8
                    })
                );

                // Create particle positions for effect
                const particleCount = 50;
                const positions = [];
                for (let i = 0; i < particleCount; i++) {
                    positions.push(
                        (Math.random() - 0.5) * 4,
                        (Math.random() - 0.5) * 4,
                        (Math.random() - 0.5) * 4
                    );
                }
                teleportEffect.geometry.setAttribute('position', 
                    new THREE.Float32BufferAttribute(positions, 3)
                );
                
                teleportEffect.position.copy(player.position);
                scene.add(teleportEffect);

                // Remove effect after animation
                setTimeout(() => {
                    scene.remove(teleportEffect);
                }, 1000);
            }
        });
    }

    function startGame() {
        if (gameStarted) return;
        console.log('Starting game...');
        
        try {
            gameStarted = true;
            
            // Create canvas first if it doesn't exist
            if (!canvas) {
                console.error('Canvas not initialized');
                gameStarted = false;
                return;
            }

            // Initialize game
            initializeGame();
            
            if (browser && canvas) {  // Check both browser and canvas
                // Add window resize listener
                window.addEventListener('resize', onWindowResize);
                
                // Add keyboard controls
                window.addEventListener('keydown', (e) => {
                    keys[e.code] = true;
                    if (e.code === 'Escape') handlePause();
                });

                window.addEventListener('keyup', (e) => {
                    keys[e.code] = false;
                });

                // Add pointer lock controls
                document.addEventListener('pointerlockchange', () => {
                    isControlsLocked = document.pointerLockElement === canvas;
                    isPaused = !isControlsLocked;
                    showPauseMenu = !isControlsLocked;
                });

                // Add click handler for canvas
                canvas.addEventListener('click', () => {
                    if (!isControlsLocked && !showPauseMenu) {
                        canvas.requestPointerLock();
                    }
                });
            }

            lastTime = performance.now();
            requestAnimationFrame(animate);
            console.log('Game started successfully');
        } catch (error) {
            console.error('Error starting game:', error);
            gameStarted = false;
        }
    }

    // Add handlePause function
    function handlePause() {
        if (isControlsLocked) {
            document.exitPointerLock();
        }
    }

    // Remove the onMount auto-start
    onMount(() => {
        console.log('Component mounted');
    });
</script>
  
<style>
    :global(body) {
        margin: 0;
        overflow: hidden;
    }
    
    .hotbar {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        gap: 5px;
        background: rgba(0,0,0,0.5);
        padding: 10px;
        border-radius: 10px;
        z-index: 100;
    }
    
    .slot {
        width: 50px;
        height: 50px;
        border: 2px solid #444;
        background: rgba(255,255,255,0.1);
        cursor: pointer;
        position: relative;
    }
    
    .selected {
        border-color: #fff;
        box-shadow: 0 0 10px rgba(255,255,255,0.5);
    }
    
    .block-preview {
        width: 100%;
        height: 100%;
        position: relative;
    }
    
    .count {
        position: absolute;
        bottom: 2px;
        right: 2px;
        font-size: 12px;
        color: white;
        text-shadow: 1px 1px 2px black;
    }

    .breaking-overlay {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 20px;
        height: 20px;
        pointer-events: none;
    }
    :global(#svelte) {
        position: relative;
        width: 100vw;
        height: 100vh;
    }
    canvas {
        width: 100%;
        height: 100%;
        cursor: pointer;
        display: block;
    }
    .overlay {
        position: fixed;
        color: white;
        font-family: monospace;
        padding: 10px;
        background: rgba(0,0,0,0.5);
        pointer-events: none;
        z-index: 2;
    }
    #debug-overlay {
        top: 10px;
        left: 10px;
    }
    #health-overlay {
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 24px;
    }
    .pause-menu {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.8);
        padding: 20px;
        border-radius: 10px;
        color: white;
        text-align: center;
        font-family: Arial, sans-serif;
        min-width: 200px;
        z-index: 999;
        pointer-events: all;
        user-select: none;
        isolation: isolate;
        touch-action: none;
    }

    .pause-menu button {
        background: #4CAF50;
        border: none;
        color: white;
        padding: 10px 20px;
        margin: 5px;
        border-radius: 5px;
        cursor: pointer;
        font-size: 16px;
        transition: background 0.3s;
        width: 100%;
    }

    .pause-menu button:hover {
        background: #45a049;
    }

    .block-highlight {
        position: absolute;
        pointer-events: none;
        border: 2px solid rgba(255, 255, 255, 0.8);
        border-radius: 3px;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
        background: transparent;
        padding: 0;
        margin: 0;
        cursor: default;
    }

    /* Ensure the button doesn't show focus outline since it's just visual */
    .block-highlight:focus {
        outline: none;
    }

    .pause-menu h2 {
        margin-top: 0;
        margin-bottom: 20px;
    }

    .time-indicator {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        position: relative;
        transition: background 0.5s;
    }

    .sun, .moon {
        position: absolute;
        width: 20px;
        height: 20px;
        top: 10px;
        right: 10px;
        border-radius: 50%;
        transition: opacity 1s;
    }

    .sun {
        background: #FFD700;
        box-shadow: 0 0 20px #FFD700;
    }

    .moon {
        background: #FFF;
        box-shadow: 0 0 20px #445588;
    }

    .controls-list {
        text-align: left;
        margin: 15px 0;
        padding: 10px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 5px;
    }

    .controls-list p {
        margin: 5px 0;
    }

    .video-container {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
    }

    .start-button {
        padding: 20px 40px;
        font-size: 24px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        transition: background 0.3s;
        z-index: 1000;
    }

    .start-button:hover {
        background: #45a049;
    }
</style>
  
<div class="game-container">
    <canvas 
        bind:this={canvas}
        style="width: 100%; height: 100vh; display: block;"
    ></canvas>

    {#if !gameStarted}
        <div class="video-container">
            <button 
                class="start-button"
                on:click={startGame}
            >
                Start Game
            </button>
        </div>
    {/if}

    <div class="hotbar" role="toolbar" aria-label="Item hotbar">
        {#each inventory.slice(0, HOTBAR_SIZE) as item, i}
            <button
                class="slot {i === selectedSlot ? 'selected' : ''}"
                on:click={() => selectedSlot = i}
                on:keydown={e => {
                    if (e.key === 'Enter') selectedSlot = i;
                    if (e.key === 'ArrowRight') selectedSlot = Math.min(selectedSlot + 1, HOTBAR_SIZE - 1);
                    if (e.key === 'ArrowLeft') selectedSlot = Math.max(selectedSlot - 1, 0);
                }}
            >
                {#if item.type > 0}
                    <div class="block-preview" style="background: {blockColors[item.type]?.top || '#fff'};">
                        <span class="count">{item.count}</span>
                    </div>
                {/if}
            </button>
        {/each}
    </div>

    {#if currentBreakingBlock && breakingProgress > 0}
        <div class="breaking-overlay"
             style="background: linear-gradient(to right, 
                    rgba(255,0,0,0.4) {breakingProgress * 100}%, 
                    transparent {breakingProgress * 100}%)">
        </div>
    {/if}

    <div id="debug-overlay" class="overlay">
        Health: {'❤️'.repeat(player?.health ?? 0)}
    </div>

    <div id="health-overlay" class="overlay">
        {'❤️'.repeat(player?.health ?? 0)}
    </div>

    <div id="time-overlay" class="overlay" style="top: 10px; right: 10px;">
        <div class="time-indicator" style="background: {isNight ? '#445588' : '#FFD700'}; 
             transform: rotate({timeOfDay * 360}deg);"></div>
        <div class="moon" style="opacity: {isNight ? 1 : 0};"></div>
        <div class="sun" style="opacity: {isNight ? 0 : 1};"></div>
        {isNight ? "Night" : "Day"}
    </div>

    <!-- Pause Menu -->
    {#if selectedBlock}
        <button 
            class="block-highlight"
            role="button"
            aria-label="Selected block"
            style="
                left: {selectedBlock.x * 100}%;
                top: {selectedBlock.y * 100}%;
                width: {BLOCK_SIZE}px;
                height: {BLOCK_SIZE}px;
            "
            on:click|preventDefault={() => {}}
            on:keydown|preventDefault={() => {}}
        >
        </button>
    {/if}

    {#if showPauseMenu}
        <div 
            class="pause-menu"
            role="dialog" 
            aria-labelledby="pause-heading"
            on:keydown={e => e.key === 'Escape' && resumeGame()}
            tabindex="-1"
        >
            <h2 id="pause-heading">Game Paused</h2>
            
            <div class="controls-list">
                <p>WASD - Move</p>
                <p>Mouse - Look around</p>
                <p>ESC - Pause/Resume</p>
                <p>Click - Attack</p>
            </div>
            
            <div class="button-group" role="group">
                <button 
                    on:click={resumeGame}
                    on:keydown={e => e.key === 'Enter' && resumeGame()}
                >
                    Resume Game
                </button>
                
                <button 
                    on:click={() => window.location.reload()}
                    on:keydown={e => e.key === 'Enter' && window.location.reload()}
                >
                    Restart Game
                </button>
            </div>
        </div>
    {/if}
</div>
