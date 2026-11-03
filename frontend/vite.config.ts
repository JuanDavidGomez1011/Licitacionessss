import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// El panel ya no habla con ningun servidor: todo esta en el navegador (ver
// `src/lib/api.js`). Este config solo tiene que servir los ficheros.
//
// `base: './'` es lo que permite abrir `dist/index.html` con doble clic, sin
// servidor. Con la base por defecto (`/`) las rutas del bundle empiezan por `/`
// y el navegador las busca en el disco raiz, que es donde falla.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // Se fija a 127.0.0.1 porque el default de Vite escucha solo en ::1 y en
    // Windows eso deja el server inalcanzable desde 127.0.0.1.
    host: '127.0.0.1',
    port: 5173,
    // Sin proxy a /api: no hay API que proxificar. Si se deja puesto, apuntaria
    // a un backend que ya no se usa.
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // `e2e/` es de Playwright y corre con `npx playwright test`, no con vitest.
    // Sin esto, vitest intenta recogerlo y falla con "Playwright Test did not
    // expect test() to be called here".
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})