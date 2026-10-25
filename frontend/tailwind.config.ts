import type { Config } from "tailwindcss";

/*
 * Dark theme with violet accents — the shared look of fclementi's apps
 * (Forecaster, STT Wizard). Instead of rewriting every class, the Tailwind
 * palette itself is remapped for a dark background:
 *   • gray is inverted: 50–200 are dark surfaces/lines, 500 is muted text,
 *     900 is the main text colour.
 *   • every hue keeps its meaning, but 50–200 become translucent tints
 *     (badge/alert backgrounds) and 600–900 become light text colours.
 *   • indigo is the brand violet.
 */

type Shades = Record<string, string>

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** A hue for dark backgrounds: `fill` for solid fills, `text` for readable text. */
function hue(fill: string, text: string, light: string): Shades {
  return {
    50: rgba(fill, 0.08),
    100: rgba(fill, 0.14),
    200: rgba(fill, 0.26),
    300: rgba(fill, 0.42),
    400: text,
    500: fill,
    600: fill,
    700: text,
    800: light,
    900: light,
    950: light,
  }
}

const gray: Shades = {
  50: "#16131f",   // subtle surface (table heads, hovers, inputs)
  100: "#1d1929",  // raised surface, dividers
  200: "#2a2639",  // borders
  300: "#3b3650",  // strong borders
  400: "#7a7396",  // placeholder / faint text
  500: "#9b94b3",  // muted text
  600: "#b6b0cb",
  700: "#cec8e0",
  800: "#e0dbef",
  900: "#ece8f7",  // main text
  950: "#f6f3fd",
}

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        gray,
        slate: gray,
        panel: "rgba(25, 21, 40, 0.72)",
        "panel-strong": "#1c1830",
        surface: "#14111f",
        page: "#0c0a14",
        indigo: { ...hue("#8b5cf6", "#a78bfa", "#ddd6fe"), 700: "#a78bfa", 800: "#c4b5fd" },
        violet: hue("#8b5cf6", "#a78bfa", "#ddd6fe"),
        purple: hue("#c084fc", "#d8b4fe", "#f3e8ff"),
        blue: hue("#60a5fa", "#93c5fd", "#dbeafe"),
        sky: hue("#38bdf8", "#7dd3fc", "#e0f2fe"),
        teal: hue("#2dd4bf", "#5eead4", "#ccfbf1"),
        emerald: hue("#34d399", "#6ee7b7", "#d1fae5"),
        green: hue("#22c55e", "#86efac", "#dcfce7"),
        yellow: hue("#eab308", "#fde047", "#fef9c3"),
        amber: hue("#f59e0b", "#fbbf24", "#fef3c7"),
        orange: hue("#f97316", "#fdba74", "#ffedd5"),
        red: hue("#ef4444", "#f87171", "#fee2e2"),
        rose: hue("#f43f5e", "#fb7185", "#ffe4e6"),
      },
      fontFamily: {
        sans: ['"Space Grotesk"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      backgroundImage: {
        accent: "linear-gradient(135deg, #8b5cf6 0%, #6d5bf0 55%, #5b6cf0 100%)",
      },
      boxShadow: {
        panel: "0 10px 40px rgba(0, 0, 0, 0.35)",
        glow: "0 4px 16px rgba(124, 58, 237, 0.3)",
        "glow-lg": "0 6px 22px rgba(124, 58, 237, 0.5)",
      },
    },
  },
  plugins: [],
};
export default config;
