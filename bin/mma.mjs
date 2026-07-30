#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const main = join(__dirname, "..", "dist", "main.js");

await import(pathToFileURL(main).href);
