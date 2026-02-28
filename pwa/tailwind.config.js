/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#1E1E2E",
        "surface-variant": "#2A2A3A",
      },
    },
  },
  plugins: [],
};
