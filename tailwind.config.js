/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // Ledger palette: cool paper, deep ink, one ultramarine accent. The "-dark" twins are used with dark:.
      colors: {
        paper: { DEFAULT: '#F3F5F8', dark: '#0B111D' },
        surface: { DEFAULT: '#FFFFFF', dark: '#141C2C' },
        ink: { DEFAULT: '#0E1A2E', dark: '#EDF1F8' },
        muted: { DEFAULT: '#586579', dark: '#97A5BA' },
        line: { DEFAULT: '#DCE2EA', dark: '#243049' },
        accent: { DEFAULT: '#2447D1', dark: '#8EA6FF', soft: '#E6EBFC', 'soft-dark': '#1B2850' },
        danger: { DEFAULT: '#B42318', soft: '#FDECEA', 'soft-dark': '#3A1714' },
        warn: { DEFAULT: '#8A5300', soft: '#FFF3DC', 'soft-dark': '#33260E' },
        ok: { DEFAULT: '#0F6B3F', soft: '#E3F5EA', 'soft-dark': '#10301F' },
      },
    },
  },
  plugins: [],
};
