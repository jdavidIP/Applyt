// Shared design tokens (DESIGN.md) for both dashboard/ and extension/ Tailwind
// configs, so the two surfaces can't visually drift apart the way the old
// blue-dashboard/green-popup CSS did. Single source of truth for color values —
// see dashboard/tailwind.config.cjs and extension/tailwind.config.cjs.
module.exports = {
  colors: {
    cream: '#FBF9F3',
    ink: '#3A3A34',
    'ink-soft': '#7A7970',
    matcha: {
      50: '#F1F5EA',
      100: '#E3EAD8',
      200: '#CFDDB9',
      400: '#7A9469',
      600: '#5C7A4C',
      800: '#3F5A30',
    },
    terracotta: {
      100: '#F7E4D5',
      600: '#C97A45',
      800: '#8A4F26',
    },
    amber: {
      100: '#FBEAD0',
      800: '#8A5A1E',
    },
    rose: {
      100: '#F5DEDD',
      800: '#96473F',
    },
    gray: {
      100: '#EDEAE0',
      700: '#6B6A61',
    },
  },
};
