import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Pre-labelling outlines its shapes in a worker thread, which runs a file of its own
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), outliner: resolve(__dirname, 'src/main/outliner.ts') } } }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
