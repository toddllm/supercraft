<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as THREE from 'three';
    import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
    import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
  
    let canvas: HTMLCanvasElement;
    const world = new Map<string, THREE.Mesh>();
    
    // Day/night cycle
    let timeOfDay = 0; // 0-1 where 0=dawn, 0.5=dusk
    const DAY_LENGTH = 300; // Seconds for full day/night cycle
    let isNight = false;
    let moonLight: THREE.DirectionalLight;
    let sunLight: THREE.DirectionalLight;
    let renderer: THREE.WebGLRenderer;
    let scene: THREE.Scene;
    let camera: THREE.PerspectiveCamera;
    let controls: PointerLockControls;
    let raycaster = new THREE.Raycaster();
    let selectedBlock: THREE.Vector3 | null = null;
    let currentBlockType = 1;
    const BLOCK_SIZE = 1;
    const RENDER_DISTANCE = 2;
    const CHUNK_SIZE = 8;
  
    // Constants
    const BREAK_DISTANCE = 5; // Max mining distance
    const INVENTORY_SIZE = 36;
    const HOTBAR_SIZE = 9;
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
  
    // Player state with higher initial position
    const player = {
        position: new THREE.Vector3(0, 10, 0),
        spawnPoint: new THREE.Vector3(0, 10, 0),
        velocity: new THREE.Vector3(),
        verticalVelocity: 0,
        speed: 5,
        health: 5,
        isGrounded: false,
        isDead: false,
        lastDamageTime: 0,
        lastRespawnTime: 0,
        damageCooldown: 1000, // 1 second cooldown for taking damage
        respawnCooldown: 3000 // 3 seconds cooldown for respawning
    };
  
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
  
    function checkCollision(position: THREE.Vector3): boolean {
        const margin = 0.2;
        const positions = [
            // Center
            [position.x, position.y, position.z],
            // Bottom corners for better ground detection
            [position.x + margin, position.y - 1.6, position.z + margin],
            [position.x + margin, position.y - 1.6, position.z - margin],
            [position.x - margin, position.y - 1.6, position.z + margin],
            [position.x - margin, position.y - 1.6, position.z - margin],
        ];

        const collision = positions.some(([x, y, z]) => {
            const block = getBlock(x, y, z);
            if (block) {
                console.log(`Collision at [${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}]`);
                return true;
            }
            return false;
        });

        return collision;
    }
  
    let lastTime = performance.now();
    let lastEnemySpawn = 0;
  
    // Add these constants at the top level
    const MOVEMENT_SPEED = 5.0;  // Make speed more noticeable
  
    function respawnPlayer() {
        const currentTime = performance.now();
        if (currentTime - player.lastRespawnTime < player.respawnCooldown) {
            console.log('Respawn on cooldown');
            return;
        }

        console.log('Respawning player');
        player.position.copy(player.spawnPoint);
        player.verticalVelocity = 0;
        player.isGrounded = false;
        player.health = 5;
        player.isDead = false;
        player.lastRespawnTime = currentTime;
        controls.getObject().position.copy(player.spawnPoint);
        controls.getObject().position.y += 1.6;
    }
  
    function damagePlayer(amount: number) {
        const currentTime = performance.now();
        if (currentTime - player.lastDamageTime < player.damageCooldown) {
            return; // Skip damage if on cooldown
        }

        player.health = Math.max(0, player.health - amount);
        player.lastDamageTime = currentTime;
        console.log(`Player took ${amount} damage. Health: ${player.health}`);
        
        if (player.health <= 0 && !player.isDead) {
            player.isDead = true;
            console.log('Player died');
            respawnPlayer();
        }
    }
  
    // Convert enum to const object
    const EnemyType = {
        ZOMBIE: 'Zombie',
        GHOST: 'Ghost',
        EMOLVER: 'Emolver',
        REVOLVER: 'Revolver',
        TYRESE: 'Tyrese',
        SKELETON: 'Skeleton',
        SWORD_SKELETON: 'Sword Skeleton',
        LAVA_GOLEM: 'Lava Golem',
        ICE_GOLEM: 'Ice Golem',
        IVORY_GOLEM: 'Ivory Golem',
        ELDER: 'Elder',
        WATER_GUARDIAN: 'Water Guardian',
        LITHER: 'Lither',
        ENDER_CRYSTAL: 'Ender Crystal',
        ENDER_DRAGON: 'Ender Dragon',
        ENDERNITE: 'Endernite',
        OLIVER: 'Oliver',
        PUMPKIN_SLIME: 'Pumpkin Slime',
        SLIME: 'Slime',
        BLAZE_CUBE: 'Blaze Cube',
        MAGMA_BLOCK: 'Magma Block',
        VAMPIRE: 'Vampire',
        MUMMY: 'Mummy',
        GOBLIN: 'Goblin',
        STLICKER: 'Stlicker',
        BABY_DRAGON: 'Baby Dragon',
        BABY_ZOMBIE: 'Baby Zombie',
        DEMIN: 'Demin',
        LAVA_BULLY: 'Lava Bully',
        LIGHTNING_ZOMBIE: 'Lightning Zombie',
        CREEPER: 'Creeper',
        TROLL: 'Troll',
        DR_NICKEL: 'Dr Nickel'
    } as const;

    type EnemyTypeKey = keyof typeof EnemyType;
  
    // Base Enemy class
    class Enemy {
        position: THREE.Vector3;
        mesh: THREE.Group;
        health: number;
        damage: number;
        speed: number;
        type: string;
        isAlive: boolean = true;

        constructor(type: string, position: THREE.Vector3) {
            this.type = type;
            this.position = position;
            this.health = this.getInitialHealth(type);
            this.damage = this.getInitialDamage(type);
            this.speed = this.getInitialSpeed(type);
            this.mesh = this.createEnemyMesh();
            this.mesh.position.copy(position);
        }

        getInitialHealth(type: string): number {
            switch(type) {
                case EnemyType.DR_NICKEL: return 1000;
                case EnemyType.ENDER_DRAGON: return 500;
                case EnemyType.LAVA_GOLEM: return 200;
                default: return 100;
            }
        }

        getInitialDamage(type: string): number {
            switch(type) {
                case EnemyType.DR_NICKEL: return 50;
                case EnemyType.ENDER_DRAGON: return 30;
                case EnemyType.LAVA_GOLEM: return 20;
                default: return 10;
            }
        }

        getInitialSpeed(type: string): number {
            switch(type) {
                case EnemyType.GHOST: return 8;
                case EnemyType.BABY_ZOMBIE: return 7;
                case EnemyType.ZOMBIE: return 2; // Slower zombie speed
                default: return 4;
            }
        }

        createEnemyMesh(): THREE.Group {
            const group = new THREE.Group();

            // Body
            const bodyGeometry = new THREE.BoxGeometry(1, 2, 1);
            const bodyMaterial = this.getEnemyMaterial();
            const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
            group.add(body);

            // Head
            const headGeometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
            const head = new THREE.Mesh(headGeometry, bodyMaterial);
            head.position.y = 1.4;
            group.add(head);

            // Add special features based on type
            this.addSpecialFeatures(group);

            return group;
        }

        getEnemyMaterial(): THREE.Material {
            switch(this.type) {
                case EnemyType.GHOST:
                    return new THREE.MeshBasicMaterial({ 
                        color: 0xffffff,
                        transparent: true,
                        opacity: 0.5
                    });
                case EnemyType.LAVA_GOLEM:
                    return new THREE.MeshPhongMaterial({ 
                        color: 0xff4400,
                        emissive: 0xff0000
                    });
                case EnemyType.ICE_GOLEM:
                    return new THREE.MeshPhongMaterial({ 
                        color: 0x88ffff,
                        transparent: true,
                        opacity: 0.8
                    });
                case EnemyType.DR_NICKEL:
                    return new THREE.MeshPhongMaterial({ 
                        color: 0x000000,
                        emissive: 0x440044
                    });
                default:
                    return new THREE.MeshPhongMaterial({ color: 0xff0000 });
            }
        }

        addSpecialFeatures(group: THREE.Group) {
            switch(this.type) {
                case EnemyType.SKELETON:
                case EnemyType.SWORD_SKELETON:
                    this.addWeapon(group);
                    break;
                case EnemyType.ENDER_DRAGON:
                    this.addWings(group);
                    break;
                case EnemyType.DR_NICKEL:
                    this.addBossFeatures(group);
                    break;
            }
        }

        addWeapon(group: THREE.Group) {
            const weaponGeometry = new THREE.BoxGeometry(0.2, 1.5, 0.2);
            const weaponMaterial = new THREE.MeshPhongMaterial({ color: 0x888888 });
            const weapon = new THREE.Mesh(weaponGeometry, weaponMaterial);
            weapon.position.set(0.8, 0, 0);
            weapon.rotation.z = Math.PI / 4;
            group.add(weapon);
        }

        addWings(group: THREE.Group) {
            const wingGeometry = new THREE.PlaneGeometry(2, 1);
            const wingMaterial = new THREE.MeshPhongMaterial({ 
                color: 0x000000,
                side: THREE.DoubleSide
            });
            
            const leftWing = new THREE.Mesh(wingGeometry, wingMaterial);
            leftWing.position.set(-1.5, 0.5, 0);
            leftWing.rotation.y = Math.PI / 4;
            
            const rightWing = new THREE.Mesh(wingGeometry, wingMaterial);
            rightWing.position.set(1.5, 0.5, 0);
            rightWing.rotation.y = -Math.PI / 4;
            
            group.add(leftWing, rightWing);
        }

        addBossFeatures(group: THREE.Group) {
            // Add glowing eyes
            const eyeGeometry = new THREE.SphereGeometry(0.1);
            const eyeMaterial = new THREE.MeshPhongMaterial({ 
                color: 0xff0000,
                emissive: 0xff0000
            });
            
            const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
            const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
            
            leftEye.position.set(-0.2, 1.4, 0.4);
            rightEye.position.set(0.2, 1.4, 0.4);
            
            group.add(leftEye, rightEye);

            // Add floating crystals
            for (let i = 0; i < 3; i++) {
                const crystal = new THREE.Mesh(
                    new THREE.OctahedronGeometry(0.3),
                    new THREE.MeshPhongMaterial({ 
                        color: 0x8800ff,
                        emissive: 0x440088
                    })
                );
                
                const angle = (i / 3) * Math.PI * 2;
                crystal.position.set(
                    Math.cos(angle) * 2,
                    2,
                    Math.sin(angle) * 2
                );
                
                group.add(crystal);
            }
        }

        update(delta: number) {
            if (!this.isAlive) return;

            // Move towards player
            const directionToPlayer = new THREE.Vector3()
                .subVectors(player.position, this.position)
                .normalize();

            this.position.add(
                directionToPlayer.multiplyScalar(this.speed * delta)
            );
            
            this.mesh.position.copy(this.position);

            // Animate based on type
            this.animate(delta);
        }

        animate(delta: number) {
            switch(this.type) {
                case EnemyType.GHOST:
                    this.mesh.position.y = this.position.y + Math.sin(performance.now() * 0.002) * 0.5;
                    break;
                case EnemyType.ENDER_DRAGON:
                    this.mesh.rotation.y += delta;
                    break;
                case EnemyType.DR_NICKEL:
                    this.animateBoss(delta);
                    break;
            }
        }

        animateBoss(delta: number) {
            // Rotate floating crystals
            this.mesh.children.forEach((child, i) => {
                if (i > 2) { // Crystal indices
                    child.rotation.y += delta * 2;
                    child.position.y = 2 + Math.sin(performance.now() * 0.002 + i) * 0.3;
                }
            });
        }

        takeDamage(amount: number) {
            this.health -= amount;
            if (this.health <= 0) {
                this.die();
            }
        }

        die() {
            this.isAlive = false;
            scene.remove(this.mesh);
        }
    }

    // Initialize enemies array
    let enemies: Enemy[] = [];

    function spawnEnemy() {
        const spawnDistance = 30;
        const angle = Math.random() * Math.PI * 2;
        const position = new THREE.Vector3(
            Math.cos(angle) * spawnDistance,
            0,
            Math.sin(angle) * spawnDistance
        );

        const enemyTypes = Object.values(EnemyType);
        const randomType = enemyTypes[Math.floor(Math.random() * (enemyTypes.length - 1))]; // Exclude DR_NICKEL
        
        const enemy = new Enemy(randomType, position);
        enemies.push(enemy);
        scene.add(enemy.mesh);
    }

    function initializeGame() {
        console.log('Initializing game...');
        
        // Scene setup
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x87CEEB);

        // Camera setup
        camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        camera.position.copy(player.position);
        camera.position.y += 1.6; // Eye height

        // Lighting
        sunLight = new THREE.DirectionalLight(0xFFFFFF, 1);
        sunLight.position.set(100, 500, 100);
        scene.add(sunLight);

        moonLight = new THREE.DirectionalLight(0x445588, 0);
        moonLight.position.set(-100, 500, -100);
        scene.add(moonLight);

        scene.add(new THREE.AmbientLight(0xFFFFFF, 0.2));

        // Ground
        const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
        const groundMaterial = new THREE.MeshStandardMaterial({ 
            color: 0x355E3B,
            roughness: 0.8,
        });
        const ground = new THREE.Mesh(groundGeometry, groundMaterial);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0;
        scene.add(ground);

        // Initial enemies
        spawnInitialEnemies();

        console.log('Game initialized');
    }

    function spawnInitialEnemies() {
        for (let i = 0; i < 5; i++) {
            spawnEnemy();
        }
    }

    let isPaused = false;
    let showPauseMenu = false;

    // Add pause menu handler
    function handlePause() {
        if (isControlsLocked) {
            document.exitPointerLock();
            // State will be updated by pointerlockchange event
        } else {
            canvas.requestPointerLock();
            // State will be updated by pointerlockchange event
        }
    }

    // Update onMount with pause handlers
    onMount(() => {
        console.log('Mounting game...');
        
        // Renderer setup
        renderer = new THREE.WebGLRenderer({ 
            canvas,
            antialias: true
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        // Initialize game
        initializeGame();

        // Controls setup
        controls = new PointerLockControls(camera, canvas);
        
        // Auto-lock controls on click
        canvas.addEventListener('mousedown', (e) => {
            // Only request pointer lock if clicking directly on canvas
            if (!isControlsLocked && e.target === canvas && !showPauseMenu) {
                e.preventDefault();
                canvas.requestPointerLock();
            }
        });

        // Handle movement and attacks
        window.addEventListener('keydown', (e) => {
            keys[e.code] = true;
        });

        window.addEventListener('keyup', (e) => {
            keys[e.code] = false;
        });

        // Handle mouse clicks for attacking and mining
        window.addEventListener('click', (e) => {
            if (isControlsLocked && !isPaused && e.button === 0) { // Left click
                // Mine blocks
                raycaster.setFromCamera(new THREE.Vector2(), camera);
                const intersects = raycaster.intersectObjects(Array.from(world.values()));
                if (intersects.length > 0 && intersects[0].distance < BREAK_DISTANCE) {
                    const pos = new THREE.Vector3(
                        Math.floor(intersects[0].point.x),
                        Math.floor(intersects[0].point.y),
                        Math.floor(intersects[0].point.z)
                    );
                    removeBlock(pos);
                } else {
                    attackEnemies();
                }
            }
        });

        // Add right-click block placement
        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (isControlsLocked && !isPaused) {
                if (selectedBlock && player.position.distanceTo(selectedBlock) < BREAK_DISTANCE) {
                    addBlock(selectedBlock.x, selectedBlock.y, selectedBlock.z, currentBlockType);
                }
            }
        });

        // Handle resize
        window.addEventListener('resize', onWindowResize);

        // Handle ESC key
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Escape') {
                handlePause();
            }
            keys[e.code] = true;
        });

        // Handle pointer lock changes
        document.addEventListener('pointerlockchange', () => {
            isControlsLocked = document.pointerLockElement === canvas;
            if (isControlsLocked) {
                isPaused = false;
                showPauseMenu = false;
            } else {
                isPaused = true;
                showPauseMenu = true;
            }
        });

        // Start animation loop
        animate();

        return () => {
            window.removeEventListener('resize', onWindowResize);
            window.removeEventListener('keydown', (e) => keys[e.code] = true);
            window.removeEventListener('keyup', (e) => keys[e.code] = false);
            document.removeEventListener('pointerlockchange', () => {});
        };
    });

    function animate() {
        requestAnimationFrame(animate);
        
        const time = performance.now();
        const delta = Math.min((time - lastTime) / 1000, 0.1);
        lastTime = time;

        // Update block breaking
        if (currentBreakingBlock && isControlsLocked && !isPaused) {
            breakingProgress += delta * 2; // Adjust speed as needed
            if (breakingProgress >= 1) {
                removeBlock(currentBreakingBlock);
                breakingProgress = 0;
                currentBreakingBlock = null;
            }
        }

        // Update day/night cycle
        timeOfDay += delta / DAY_LENGTH;
        if(timeOfDay > 1) timeOfDay -= 1;
        
        // Update lighting
        const sunAngle = timeOfDay * Math.PI * 2;
        sunLight.position.set(Math.cos(sunAngle) * 500, Math.abs(Math.sin(sunAngle)) * 500, Math.sin(sunAngle) * 500);
        
        // Blend between sun and moon
        isNight = timeOfDay > 0.25 && timeOfDay < 0.75;
        sunLight.intensity = isNight ? 0 : Math.sin(timeOfDay * Math.PI) * 0.8;
        moonLight.intensity = isNight ? Math.sin(timeOfDay * Math.PI * 2) * 0.5 : 0;
        
        // Adjust sky color
        scene.background = new THREE.Color().setHSL(
            0.6,
            0.1,
            Math.sin(timeOfDay * Math.PI) * 0.4 + 0.3
        );

        // Only update game if not paused and controls are locked
        if (!isPaused && isControlsLocked) {
            // Movement
            const speed = player.speed;
            const moveDirection = new THREE.Vector3();

            if (keys['KeyW']) moveDirection.z -= 1;
            if (keys['KeyS']) moveDirection.z += 1;
            if (keys['KeyA']) moveDirection.x -= 1;
            if (keys['KeyD']) moveDirection.x += 1;

            if (moveDirection.length() > 0) {
                moveDirection.normalize();
                moveDirection.multiplyScalar(speed * delta);
                
                // Apply movement relative to camera direction
                const cameraDirection = new THREE.Vector3();
                camera.getWorldDirection(cameraDirection);
                const angle = Math.atan2(cameraDirection.x, cameraDirection.z);
                
                moveDirection.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
                player.position.add(moveDirection);
                
                // Update camera position
                controls.getObject().position.copy(player.position);
                controls.getObject().position.y += 1.6; // Eye height
            }

            // Update enemies and check for collisions
            enemies = enemies.filter(enemy => enemy.isAlive);
            enemies.forEach(enemy => {
                enemy.update(delta);
                
                // Check for collision with player
                const distanceToPlayer = enemy.position.distanceTo(player.position);
                if (distanceToPlayer < 2) { // If enemy is within 2 units of player
                    damagePlayer(enemy.damage * delta); // Scale damage by time
                }
            });

            // Spawn new enemies
            if (time - lastEnemySpawn > 5000) {
                spawnEnemy();
                lastEnemySpawn = time;
            }
        }

        renderer.render(scene, camera);
    }

    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // Attack function
    function attackEnemies() {
        // Get direction player is facing
        const cameraDirection = new THREE.Vector3();
        camera.getWorldDirection(cameraDirection);

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
</style>
  
<canvas bind:this={canvas}></canvas>

<div class="hotbar">
    {#each inventory.slice(0, HOTBAR_SIZE) as item, i}
        <div class="slot {i === selectedSlot ? 'selected' : ''}"
             on:click={() => selectedSlot = i}>
            {#if item.type > 0}
                <div class="block-preview" style="background: {blockColors[item.type]?.top || '#fff'};">
                    <span class="count">{item.count}</span>
                </div>
            {/if}
        </div>
    {/each}
</div>

{#if currentBreakingBlock && breakingProgress > 0}
    <div class="breaking-overlay"
         style="background: linear-gradient(to right, 
                rgba(255,0,0,0.4) {breakingProgress * 100}%, 
                transparent {breakingProgress * 100}%)">
    </div>

<div id="debug-overlay" class="overlay">
    Health: {'❤️'.repeat(player.health)}
</div>

<div id="health-overlay" class="overlay">
    {'❤️'.repeat(player.health)}
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
    <div class="block-highlight"
        style="
            left: {selectedBlock.x * 100}%;
            top: {selectedBlock.y * 100}%;
            width: {BLOCK_SIZE}px;
            height: {BLOCK_SIZE}px;
        "
    />
{/if}

{#if showPauseMenu}
    <div class="pause-menu">
        <h2>Game Paused</h2>
        
        <div class="controls-list">
            <p>WASD - Move</p>
            <p>Mouse - Look around</p>
            <p>ESC - Pause/Resume</p>
            <p>Click - Attack</p>
        </div>
        
        <div on:mousedown|stopPropagation on:click|stopPropagation>
            <button on:click={resumeGame}>
                Resume Game
            </button>
            
            <button on:click={() => window.location.reload()}>
                Restart Game
            </button>
        </div>
    </div>
{/if}
