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
    const RENDER_DISTANCE = 4;
    const CHUNK_SIZE = 16;
  
    // Block colors [air, grass, dirt, stone, wood, leaves]
    const blockColors = [
      null,
      { top: '#4f7d20', side: '#6b8c42', bottom: '#8b7355' }, // Grass
      { top: '#8b7355', side: '#8b7355', bottom: '#8b7355' }, // Dirt
      { top: '#808080', side: '#808080', bottom: '#808080' }, // Stone
      { top: '#8b5a2b', side: '#8b5a2b', bottom: '#8b5a2b' }, // Wood
      { top: '#317f43', side: '#317f43', bottom: '#317f43' }, // Leaves
    ];
  
    // Player state
    const player = {
      position: new THREE.Vector3(0, 32, 0),
      speed: 5.0,
      gravity: -9.8,
      verticalVelocity: 0,
      isGrounded: false
    };
  
    // World generation
    const noise = new SimplexNoise();
    let lastChunkX = Infinity;
    let lastChunkZ = Infinity;
    const activeChunks = new Set<string>();
  
    // Movement handling
    let keys: { [key: string]: boolean } = {};
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
      if (activeChunks.has(chunkKey)) return;
      activeChunks.add(chunkKey);
  
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          const wx = chunkX * CHUNK_SIZE + x;
          const wz = chunkZ * CHUNK_SIZE + z;
          const height = Math.floor(noise.noise(wx / 30, wz / 30) * 8 + 32);
          
          for (let y = 0; y < height; y++) {
            let type = 3; // Stone
            if (y === height - 1) type = 1; // Grass
            else if (y > height - 4) type = 2; // Dirt
            addBlock(wx, y, wz, type);
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
  
      for (let x = -RENDER_DISTANCE; x <= RENDER_DISTANCE; x++) {
        for (let z = -RENDER_DISTANCE; z <= RENDER_DISTANCE; z++) {
          generateChunk(currentChunkX + x, currentChunkZ + z);
        }
      }
  
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
            for (let y = 0; y < 64; y++) {
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
  
    onMount(() => {
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
      
      renderer = new THREE.WebGLRenderer({ 
        canvas,
        antialias: true,
        powerPreference: "high-performance"
      });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
  
      controls = new PointerLockControls(camera, renderer.domElement);
      scene.add(controls.getObject());
  
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
  
      // Event listeners
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'Space' && player.isGrounded) {
          player.verticalVelocity = 5.0;
          player.isGrounded = false;
        }
        if (e.code === 'Digit1') currentBlockType = 1;
        if (e.code === 'Digit2') currentBlockType = 2;
        if (e.code === 'Digit3') currentBlockType = 3;
        if (e.code === 'Digit4') currentBlockType = 4;
        if (e.code === 'Digit5') currentBlockType = 5;
      };
  
      const onMouseDown = () => {
        if (!controls.isLocked) {
          controls.lock();
        }
      };
  
      const onKeyPress = (e: KeyboardEvent) => {
        keys[e.code] = e.type === 'keydown';
      };
  
      canvas.addEventListener('click', onMouseDown);
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keydown', onKeyPress);
      document.addEventListener('keyup', onKeyPress);
  
      let lastTime = performance.now();
      const animate = () => {
        requestAnimationFrame(animate);
        const now = performance.now();
        const delta = Math.min(100, now - lastTime) / 1000;
        lastTime = now;
  
        if (controls.isLocked) {
          // Movement vectors based on camera direction
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
          forward.y = 0;
          right.y = 0;
          forward.normalize();
          right.normalize();
  
          // Movement calculation
          const moveDirection = new THREE.Vector3();
          if (keys.KeyW) moveDirection.add(forward);
          if (keys.KeyS) moveDirection.sub(forward);
          if (keys.KeyA) moveDirection.sub(right);
          if (keys.KeyD) moveDirection.add(right);
  
          moveDirection.normalize().multiplyScalar(player.speed * delta);
          player.position.add(moveDirection);
  
          // Gravity
          player.verticalVelocity += player.gravity * delta;
          player.position.y += player.verticalVelocity * delta;
  
          // Ground collision
          if (player.position.y < 0) {
            player.position.y = 0;
            player.verticalVelocity = 0;
            player.isGrounded = true;
          } else {
            player.isGrounded = false;
          }
  
          // Update camera position (first-person view)
          camera.position.set(
            player.position.x,
            player.position.y + 1.6, // Eye height
            player.position.z
          );
  
          updateChunks();
        }
  
        updateSelectedBlock();
        renderer.render(scene, camera);
      };
  
      animate();
  
      const onResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      };
  
      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('resize', onResize);
        canvas.removeEventListener('click', onMouseDown);
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keydown', onKeyPress);
        document.removeEventListener('keyup', onKeyPress);
      };
    });
  
    onDestroy(() => {
      world.forEach(block => scene.remove(block));
      geometryPool.dispose();
      materialCache.forEach(material => material.dispose());
      renderer?.dispose();
    });
  </script>
  
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
  
  <style>
    :global(body) {
      margin: 0;
      overflow: hidden;
      font-family: 'Minecraft', sans-serif;
    }
    
    canvas {
      width: 100vw;
      height: 100vh;
      display: block;
      cursor: pointer;
    }
  
    .hotbar {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 5px;
      background: rgba(0, 0, 0, 0.5);
      padding: 8px;
      border-radius: 8px;
    }
  
    .slot {
      width: 40px;
      height: 40px;
      background: #8b8b8b;
      border: 2px solid #000;
    }
  
    .selected {
      border-color: #ff0;
    }
  </style>