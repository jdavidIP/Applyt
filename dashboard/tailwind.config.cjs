const { colors } = require('../shared/tailwind-tokens.cjs');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors,
    },
  },
  plugins: [],
};
