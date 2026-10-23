// REKODA PATCH (not upstream): the only local file server inspect.mjs and scenes.mjs may start.
// See .claude/skills/SOURCES.md, "Patches to vendored files".
//
// Upstream served the working directory (or the file's folder) to the inspected page, whose scripts
// can read anything served. Technical rules enforced here, not left to prose:
//   1. The served root is always dirname(target), never the working directory.
//   2. The root must carry an explicit opt-in marker file, `.taste-serve-root`, that the agent
//      creates on purpose in a directory holding only a built page and its assets.
//   3. The root may not be, contain, or sit above a git work tree (no `.git` inside it, and it is
//      not the git toplevel of the cwd or of itself, nor an ancestor of either), nor $HOME or `/`.
//   4. Requests resolve through realpath, so `..`, encoded traversal and symlinks cannot leave the
//      root; any path segment starting with "." (dotfiles, `.git`, `.env`) is refused, so the
//      marker itself is never served; only GET/HEAD; the Host header must be 127.0.0.1:<port>.
//   5. The listener binds 127.0.0.1 only.
import { existsSync, realpathSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, dirname, extname, sep, relative, parse } from 'node:path';
import { createServer } from 'node:http';
import { homedir } from 'node:os';

export const MARKER = '.taste-serve-root';

const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

/** Nearest ancestor of `start` (inclusive) that holds a `.git` entry, or null. */
function gitToplevel(start) {
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (d === parse(d).root) return null;
  }
}

/** Returns the real path of the serve root for `file`, or throws an Error saying why it is refused. */
export function safeServeRoot(file, cwd = process.cwd()) {
  const realFile = realpathSync(resolve(file));
  const root = dirname(realFile);
  if (!existsSync(join(root, MARKER))) {
    throw new Error(`refusing to serve ${root}: it has no ${MARKER} marker. Copy the built page and only its assets into a directory of their own, create ${MARKER} there on purpose, and run again.`);
  }
  if (existsSync(join(root, '.git'))) throw new Error(`refusing to serve ${root}: it contains .git.`);
  if (root === parse(root).root || root === realpathSync(homedir())) throw new Error(`refusing to serve ${root}: it is a filesystem or home root.`);
  const tops = [gitToplevel(root), gitToplevel(realpathSync(resolve(cwd)))].filter(Boolean).map((t) => realpathSync(t));
  for (const top of tops) {
    if (inside(top, root)) throw new Error(`refusing to serve ${root}: it is, or contains, the git repository at ${top}.`);
  }
  return root;
}

/** Starts the server on 127.0.0.1 (ephemeral port) for an already-validated root. */
export async function startSafeServer(root) {
  const real = realpathSync(root);
  let port = 0;
  const server = createServer((req, res) => {
    const deny = (code) => { res.writeHead(code); res.end(); };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
      if (req.headers.host !== `127.0.0.1:${port}`) return deny(403);
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (pathname.includes('\0')) return deny(400);
      if (pathname.split('/').some((seg) => seg.startsWith('.'))) return deny(403);
      let f = resolve(join(real, pathname));
      if (!inside(f, real)) return deny(403);
      f = realpathSync(f);
      if (!inside(f, real)) return deny(403);
      if (statSync(f).isDirectory()) f = join(f, 'index.html');
      f = realpathSync(f);
      if (!inside(f, real) || relative(real, f).split(sep).some((s) => s.startsWith('.'))) return deny(403);
      const size = statSync(f).size;
      res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(f).pipe(res);
    } catch { deny(404); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  return { server, port, root: real };
}

/** For a local file target: validate, serve, and return { server, url }. Exits 2 on refusal. */
export async function serveLocalFile(target) {
  const file = resolve(target);
  if (!existsSync(file)) { console.error('No such file: ' + file); process.exit(2); }
  let root;
  try { root = safeServeRoot(file); } catch (e) { console.error(e.message); process.exit(2); }
  const { server, port, root: real } = await startSafeServer(root);
  const rel = relative(real, realpathSync(file)).split(sep).map(encodeURIComponent).join('/');
  return { server, url: `http://127.0.0.1:${port}/${rel}` };
}
