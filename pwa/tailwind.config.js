/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      screens: {
        // A short window (split screen, about 380 CSS px tall): the Talk
        // screen gives up everything but the Hold to talk bar first.
        short: { raw: "(max-height: 520px)" },
        // A very short window (his split-screen half, about 175 CSS px once
        // Chrome's address bar has taken its share): the header, the tab bar
        // and the padding shrink to a line each so Hold to talk stays whole.
        // Declared after `short` so its classes win where both apply.
        tiny: { raw: "(max-height: 300px)" },
        // A bare window (under about 200px: his split-screen half with the
        // address bar, and smaller): only Hold to talk remains. The header
        // and the tab bar are hidden, the button fills the window, a handle
        // beside it opens the menu. 175px, his size, sits below the line;
        // 240px, which keeps its header and tabs, sits above it.
        bare: { raw: "(max-height: 200px)" },
        // A tiny bare window (under about 60px): the label gives way to the
        // mic icon alone; the button stays 40px or more.
        mic: { raw: "(max-height: 60px)" },
      },
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
