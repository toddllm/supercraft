<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as THREE from 'three';
    import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
    import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
  
    let canvas: HTMLCanvasElement;
    const world = new Map<string, THREE.Mesh>();
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
  
    // Block colors [air, grass, dirt, stone, wood, leaves]
    const blockColors = [
      null,
      { top: '#4f7d20', side: '#6b8c42', bottom: '#8b7355' }, // Grass
      { top: '#8b7355', side: '#8b7355', bottom: '#8b7355' }, // Dirt
      { top: '#808080', side: '#808080', bottom: '#808080' }, // Stone
      { top: '#8b5a2b', side: '#8b5a2b', bottom: '#8b5a2b' }, // Wood
      { top: '#317f43', side: '#317f43', bottom: '#317f43' }, // Leaves
    ];
  
    // Debug state
    let debugLastPrint = 0;
    const DEBUG_INTERVAL = 1000;
    
    // Make keys reactive
    let keys: { [key: string]: boolean } = {};
    $: console.log('Keys state changed:', keys);
  
    // Player state
    const player = {
      position: new THREE.Vector3(0, 32, 0),
      speed: 5.0,
      gravity: -20.0,
      jumpForce: 15.0,
      verticalVelocity: 0,
      isGrounded: false
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
  
    function addBlock(x: number, y: number, z: number, type: number) {
      if (type === 0) return;
      const key = `${x}|${y}|${z}`;
      if (world.has(key)) return;
  
      const colors = blockColors[type];
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
  
    function removeBlock(pos: THREE.Vector3) {
      const key = `${Math.floor(pos.x)}|${Math.floor(pos.y)}|${Math.floor(pos.z)}`;
      const block = world.get(key);
      if (block) {
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
  
    let lastTime = performance.now(); // Add this at the top level
  
    // Add these constants at the top level
    const MOVEMENT_SPEED = 5.0;  // Make speed more noticeable
  
    onMount(() => {
      console.log('🚀 Mounting game...');

      console.log('Starting world generation');
      console.time('Initial world generation');
  
      scene = new THREE.Scene();
      console.log('Scene created');
      camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
      console.log('Camera created');
      
      renderer = new THREE.WebGLRenderer({ 
        canvas,
        antialias: true,
        powerPreference: "high-performance"
      });
      console.log('Renderer created');
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
  
      controls = new PointerLockControls(camera, renderer.domElement);
      console.log('Controls created');
      scene.add(controls.getObject());
  
      // Add controls lock change listener
      controls.addEventListener('lock', () => {
        console.log('Controls locked');
        isControlsLocked = true;
      });
      
      controls.addEventListener('unlock', () => {
        console.log('Controls unlocked');
        isControlsLocked = false;
      });
  
      // Generate only the immediate chunks around spawn
      const spawnChunkX = Math.floor(player.position.x / CHUNK_SIZE);
      const spawnChunkZ = Math.floor(player.position.z / CHUNK_SIZE);
      
      console.log(`Generating spawn area around chunk (${spawnChunkX}, ${spawnChunkZ})`);
      
      // Generate the spawn chunk and immediate neighbors
      for (let x = -1; x <= 1; x++) {
          for (let z = -1; z <= 1; z++) {
              generateChunk(spawnChunkX + x, spawnChunkZ + z);
          }
      }
  
      console.timeEnd('Initial world generation');
      console.log(`Initial chunks generated: ${activeChunks.size}`);
  
      // Initial world generation
      updateChunks();
  
      // Lighting
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
      scene.add(ambientLight);
  
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
      directionalLight.position.set(100, 100, 100);
      scene.add(directionalLight);
  
      scene.background = new THREE.Color(0x87CEEB);
      camera.position.set(player.position.x, player.position.y + 1.6, player.position.z);
  
      // Key handlers
      function handleKeyDown(event: KeyboardEvent) {
        console.log('Key down:', {
          code: event.code,
          isGrounded: player.isGrounded,
          verticalVelocity: player.verticalVelocity
        });
        event.preventDefault();
        keys[event.code] = true;
      }

      function handleKeyUp(event: KeyboardEvent) {
        console.log('Key up:', {
          code: event.code,
          isGrounded: player.isGrounded,
          verticalVelocity: player.verticalVelocity
        });
        event.preventDefault();
        keys[event.code] = false;
      }

      // Mouse handler
      function handleMouseDown() {
        console.log('Mouse clicked, requesting pointer lock');
        controls.lock();
      }

      // Add event listeners
      console.log('Adding event listeners...');
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      canvas.addEventListener('click', handleMouseDown);
  
      const animate = () => {
        requestAnimationFrame(animate);
        
        if (isControlsLocked) {
            const now = performance.now();
            const delta = Math.min((now - lastTime) / 1000, 0.1);
            lastTime = now;

            // Test movement directly
            if (keys['KeyW']) {
                player.position.z -= player.speed * delta;
                console.log('W pressed - Moving forward');
            }
            if (keys['KeyS']) {
                player.position.z += player.speed * delta;
                console.log('S pressed - Moving backward');
            }
            if (keys['KeyA']) {
                player.position.x -= player.speed * delta;
                console.log('A pressed - Moving left');
            }
            if (keys['KeyD']) {
                player.position.x += player.speed * delta;
                console.log('D pressed - Moving right');
            }

            // Handle jumping - with debug logs
            if (keys['Space'] && player.isGrounded) {
                console.log('Jump initiated:', {
                    beforeVelocity: player.verticalVelocity,
                    beforeY: player.position.y
                });
                
                player.verticalVelocity = player.jumpForce;
                player.isGrounded = false;
                
                console.log('Jump started:', {
                    afterVelocity: player.verticalVelocity,
                    jumpForce: player.jumpForce
                });
            }

            // Apply gravity with debug
            const oldVelocity = player.verticalVelocity;
            player.verticalVelocity += player.gravity * delta;
            
            console.log('Vertical movement:', {
                oldVelocity: oldVelocity.toFixed(2),
                newVelocity: player.verticalVelocity.toFixed(2),
                gravityEffect: (player.gravity * delta).toFixed(2),
                delta: delta.toFixed(3)
            });

            // Calculate new position
            const oldY = player.position.y;
            const newY = oldY + (player.verticalVelocity * delta);
            
            // Get block below player
            const blockBelow = getBlock(
                Math.floor(player.position.x),
                Math.floor(newY - 1.8),
                Math.floor(player.position.z)
            );

            // Get block at player's head level (for ceiling collisions)
            const blockAbove = getBlock(
                Math.floor(player.position.x),
                Math.floor(newY + 0.2), // Check slightly above head
                Math.floor(player.position.z)
            );

            console.log('Position update:', {
                oldY: oldY.toFixed(2),
                newY: newY.toFixed(2),
                blockBelow: !!blockBelow,
                blockAbove: !!blockAbove,
                verticalVelocity: player.verticalVelocity.toFixed(2),
                isGrounded: player.isGrounded
            });

            if (blockBelow && player.verticalVelocity < 0) {
                // Hit ground
                player.verticalVelocity = 0;
                player.isGrounded = true;
                player.position.y = Math.floor(newY - 1.8) + 2.8; // Place player on top of block
                console.log('Landed on ground');
            } else if (blockAbove && player.verticalVelocity > 0) {
                // Hit ceiling
                player.verticalVelocity = 0;
                player.position.y = oldY;
                console.log('Hit ceiling');
            } else {
                // In air - update position
                player.position.y = newY;
                player.isGrounded = false;
            }

            // Update camera position
            controls.getObject().position.copy(player.position);
            controls.getObject().position.y += 1.6; // Eye height

            // Update debug overlay with more detailed info
            document.getElementById('debug-overlay').innerHTML = `
                Position: (${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(1)})<br>
                Velocity: ${player.verticalVelocity.toFixed(1)}<br>
                Grounded: ${player.isGrounded}<br>
                Block Below: ${!!blockBelow}<br>
                Block Above: ${!!blockAbove}<br>
                Delta: ${delta.toFixed(3)}<br>
                Space Pressed: ${keys['Space']}<br>
                Jump Force: ${player.jumpForce}
            `;
        }

        updateChunks();
        renderer.render(scene, camera);
      };
  
      console.log('Starting animation loop...');
      animate();
  
      // Set initial position high enough to see terrain
      player.position.set(0, 32, 0);
      camera.position.copy(player.position);
      camera.position.y += 1.6; // Eye height
      controls.getObject().position.copy(camera.position);

      console.log('Initial positions set:', {
          player: player.position.clone(),
          camera: camera.position.clone(),
          controls: controls.getObject().position.clone()
      });

      const onResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      };
  
      window.addEventListener('resize', onResize);
      return () => {
        console.log('Cleaning up...');
        window.removeEventListener('resize', onResize);
        canvas.removeEventListener('click', handleMouseDown);
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
      };
    });
  
    onDestroy(() => {
      world.forEach(block => scene.remove(block));
      geometryPool.dispose();
      materialCache.forEach(material => material.dispose());
      renderer?.dispose();
    });
  </script>
  
  <style>
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    canvas {
        width: 100%;
        height: 100%;
        position: fixed;
        top: 0;
        left: 0;
    }
  </style>
  
  <canvas bind:this={canvas}></canvas>
  
  {#if typeof document !== 'undefined'}
    <div class="hotbar">
      {#each [1, 2, 3, 4, 5] as i}
        <div class="slot {i === currentBlockType ? 'selected' : ''}" 
             style="background-color: {blockColors[i].side}">
        </div>
      {/each}
    </div>
  {/if}
  
  <!-- Debug overlay -->
  <div id="debug-overlay" 
    style="position: fixed; top: 10px; left: 10px; color: white; font-family: monospace; background: rgba(0,0,0,0.5); padding: 10px; z-index: 1000;">
    Loading...
  </div>