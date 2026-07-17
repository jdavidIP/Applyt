const { colors } = require('../shared/tailwind-tokens.cjs');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/popup/**/*.{html,ts}'],
  theme: {
    extend: {
      colors,
    },
  },
  plugins: [],
};
