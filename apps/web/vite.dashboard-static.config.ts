import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({root:fileURLToPath(new URL("./",import.meta.url)),base:"./",publicDir:false,plugins:[react()],
  build:{emptyOutDir:false,manifest:true,rolldownOptions:{input:fileURLToPath(new URL("dashboard-static.html",import.meta.url))}}});
