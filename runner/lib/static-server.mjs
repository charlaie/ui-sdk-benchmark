// Minimal static file server that serves a directory under a subpath (default /app/), so tests
// exercise the "works when served from a subpath" requirement.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.txt': 'text/plain' }

export function serveStatic(dir, { prefix = '/app/', port = 0 } = {}) {
  const root = path.resolve(dir)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404).end('not found')
      return
    }
    let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html'
    if (rel.endsWith('/')) rel += 'index.html'
    const file = path.resolve(root, rel)
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address()
      resolve({ url: `http://127.0.0.1:${p}${prefix}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}
