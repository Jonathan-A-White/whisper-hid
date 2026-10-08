/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#1E1E2E",
        "surface-variant": "#2A2A3A",
        // Postern's dark-theme tokens (--pc-*), for the Talk bar
        canvas: "#0a0e17",
        accent: "#f2b544",
        "accent-fg": "#1a1204",
        needs: "#f2b544",
        muted: "#7d8599",
      },
    },
  },
  plugins: [],
};
