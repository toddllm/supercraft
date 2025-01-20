import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  optimizeDeps: {
    include: [
      'three/addons/controls/PointerLockControls',
      'three/addons/math/SimplexNoise'
    ]
  },
  ssr: {
    noExternal: ['three', '@types/three', 'three-stdlib']
  }
});