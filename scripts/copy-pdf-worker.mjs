// Copies pdf.js's worker into /public so PDF import works without a CDN.
import fs from "node:fs";
import path from "node:path";
const src = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const dst = path.join(process.cwd(), "public", "pdf.worker.min.mjs");
if (fs.existsSync(src)) fs.copyFileSync(src, dst);
