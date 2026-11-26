import { fileURLToPath } from "node:url";
// The original voice TypeScript was lost. Preserve the recovered readable runtime.
export default {
  input: "src/runtime.js",
  plugins: [{ name: "hls-player", resolveId(source) {
    if (source === "hls.js") return fileURLToPath(import.meta.resolve(source));
  } }],
  output: { file: "dist/index.js", format: "esm", sourcemap: true },
};
