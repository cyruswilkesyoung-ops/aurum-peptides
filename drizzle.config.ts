import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  // Netlify applies migrations from this directory automatically at deploy time.
  out: "netlify/database/migrations",
});
