#!/usr/bin/env node
// Serve a built app (or the gallery) under /app/ for manual testing:  node scripts/serve.mjs <dir> [port]
import { serveStatic } from '../runner/lib/static-server.mjs'
const [dir, port = '4173'] = process.argv.slice(2)
if (!dir) {
  console.error('usage: node scripts/serve.mjs <dir> [port]')
  process.exit(2)
}
const s = await serveStatic(dir, { port: Number(port) })
console.log(`Serving ${dir} at ${s.url}`)
