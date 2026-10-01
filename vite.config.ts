import { defineConfig } from "vite";

// GitHub Pages serves the site from /league-of-ten/.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/league-of-ten/" : "/",
}));
