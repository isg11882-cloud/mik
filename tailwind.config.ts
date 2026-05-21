import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: '#0D1B2E',
          blue: '#1F4E79',
          purple: '#6A3FA0',
          gold: '#FFD700',
        },
      },
    },
  },
  plugins: [],
}

export default config
