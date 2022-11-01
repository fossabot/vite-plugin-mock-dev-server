import { defineConfig } from 'vite'
import mockServer from 'vite-plugin-mock-dev-server'

export default defineConfig({
  plugins: [
    mockServer({
      include: 'example/mock/**/*.mock.ts',
    }),
  ],
  server: {
    proxy: {
      '^/api': {
        target: '',
      },
    },
  },
})
