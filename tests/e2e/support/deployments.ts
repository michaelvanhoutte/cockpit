import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';

/**
 * A stand-in for the place Cockpit is deployed, for specs that need a real
 * service worker: it serves the production build (apps/web/dist) and decides
 * when a "deploy" lands. F3 otherwise runs Vite's dev server, which registers no
 * worker at all.
 *
 * **Later deploys are derived from the one build, never rebuilt.** Version 1 is
 * the build as it is. Each later one is a copy in which every file under
 * `assets/` is renamed and every reference to it rewritten, including the
 * entry module the app reads its own version from (`updating.ts`, `buildOf`)
 * and the precache manifest in `sw.js`, whose start page revision is
 * recomputed. So a browser sees a new worker script, new addresses for
 * everything the shell is made of, and an old version whose files are gone.
 *
 * **It copies the behaviours of Cloudflare the worker depends on, and is not
 * Cloudflare.** A navigation to an address nothing answers gets the start page,
 * `/index.html` is redirected to `/`, and a deploy removes the previous
 * version's files, so what only it had is a 404. Checking staging before
 * promoting still covers the real thing.
 *
 * API calls (`/v1/...`) are answered `401`, which is enough for the signed-out
 * shell to open. Nothing here is signed in or stores anything.
 */
export interface Deployments {
  /** Where the browser opens it; `localhost`, so the page counts as a secure context. */
  readonly origin: string;
  /** The version being served now, counted from 1. */
  readonly version: number;
  /** The address of a version's entry module, which is what the app takes for its build. */
  entryOf(version: number): string;
  /** An address under `assets/` that `version` has and the next one does not. */
  aFileOf(version: number): string;
  /** Lands the next version, removing the files of the one it replaces. */
  deploy(): number;
  /**
   * Holds back every file of the version being served now, mid-download: a
   * request for one is received and not answered until `release`. The start
   * page, the worker script and the manifest are not held, so the browser can
   * still find out the version exists while it waits for what it is made of.
   */
  hold(): Hold;
  /** Stops the server and removes every copy. */
  close(): Promise<void>;
}

export interface Hold {
  /** Resolves once a file of the held version has been asked for. */
  asked: Promise<void>;
  /** Answers everything that waited, and everything asked for afterwards. */
  release(): void;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** What is read as text when versions are derived; everything else is binary and keeps its bytes. */
const TEXT = new Set(['.html', '.js', '.css', '.webmanifest']);

export async function serveDeployments(build: string): Promise<Deployments> {
  if (!existsSync(join(build, 'index.html'))) {
    throw new Error(`${build} has no index.html: the production build has to exist (pnpm --filter web build).`);
  }
  const root = mkdtempSync(join(tmpdir(), 'cockpit-deployments-'));
  const directory = (version: number) => join(root, `v${version}`);
  // Version 1 is the build as it stands, copied so that a deploy deleting it
  // never touches the checkout's own dist. A second copy stays unserved: every
  // later version is derived from it, and version 1's own files are the first
  // to be removed.
  const original = join(root, 'original');
  cpSync(build, original, { recursive: true });
  cpSync(original, directory(1), { recursive: true });

  let live = 1;
  const holds = new Map<number, { gate: Promise<void>; open(): void; ask(): void }>();

  // Read when a version is made, since a version's files are gone once it is
  // replaced and a spec still asks what it was.
  const known = new Map<number, { entry: string; lazy: string }>();
  const describe = (version: number) => {
    const page = readFileSync(join(directory(version), 'index.html'), 'utf8');
    const entry = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(page)?.[1];
    if (!entry) throw new Error(`version ${version} has no entry module in its start page`);
    const lazy = readdirSync(join(directory(version), 'assets')).find(
      (name) => name.endsWith('.js') && `/assets/${name}` !== entry && !name.startsWith('index-'),
    );
    if (!lazy) throw new Error(`version ${version} has no lazy chunk to ask for`);
    known.set(version, { entry, lazy: `/assets/${lazy}` });
  };
  describe(1);
  const factsOf = (version: number) => {
    const facts = known.get(version);
    if (!facts) throw new Error(`version ${version} has not been deployed`);
    return facts;
  };

  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    // Taken before anything is awaited: a request belongs to the version live
    // when it arrived, which is what a held download needs.
    const version = live;
    const path = decodeURIComponent((request.url ?? '/').split(/[?#]/)[0] ?? '/');
    if (path.startsWith('/v1/') || path === '/health') {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    // Cloudflare's default HTML handling: the start page lives at `/`, and asking
    // for it by its file name is redirected there, query kept. A worker that
    // hands that redirect to a navigation is what fails it.
    if (path === '/index.html') {
      const url = request.url ?? '';
      response.writeHead(307, { location: url.includes('?') ? `/${url.slice(url.indexOf('?'))}` : '/' }).end();
      return;
    }
    const file = join(directory(version), normalize(path === '/' ? '/index.html' : path));
    const inside = file.startsWith(directory(version) + sep);
    const isFile = inside && existsSync(file) && statSync(file).isFile();
    if (isFile && path.startsWith('/assets/')) {
      const hold = holds.get(version);
      if (hold) {
        hold.ask();
        await hold.gate;
      }
    }
    const served = isFile
      ? file
      : // Cloudflare answers a navigation nothing owns with the start page, and
        // everything else that is missing with a plain 404.
        request.headers['sec-fetch-mode'] === 'navigate'
        ? join(directory(version), 'index.html')
        : null;
    if (!served || !existsSync(served)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    response
      .writeHead(200, {
        'content-type': TYPES[extname(served)] ?? 'application/octet-stream',
        // Cloudflare's own default for assets: always asked again.
        'cache-control': 'public, max-age=0, must-revalidate',
      })
      .end(readFileSync(served));
  };

  const server: Server = createServer((request, response) => {
    answer(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, ready));
  const port = (server.address() as { port: number }).port;

  return {
    origin: `http://localhost:${port}`,
    get version() {
      return live;
    },
    entryOf: (version) => factsOf(version).entry,
    aFileOf: (version) => factsOf(version).lazy,
    deploy() {
      const previous = live;
      const next = previous + 1;
      derive(original, directory(next), next);
      describe(next);
      live = next;
      rmSync(directory(previous), { recursive: true, force: true });
      return next;
    },
    hold() {
      const version = live;
      let open!: () => void;
      let ask!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const asked = new Promise<void>((resolve) => (ask = resolve));
      holds.set(version, { gate, open, ask });
      return { asked, release: open };
    },
    async close() {
      for (const hold of holds.values()) hold.open();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Makes version `version` out of the original build's files, in `to`: renames everything
 * under `assets/`, rewrites each reference, and gives `index.html` the
 * revision its new content earns in the precache manifest.
 */
function derive(from: string, to: string, version: number): void {
  cpSync(from, to, { recursive: true });
  const assets = join(to, 'assets');
  const renamed = new Map<string, string>();
  for (const name of readdirSync(assets)) {
    const dot = name.lastIndexOf('.');
    renamed.set(name, `${name.slice(0, dot)}-d${version}${name.slice(dot)}`);
  }
  // One pass over an alternation, so a name is never rewritten twice.
  const names = new RegExp([...renamed.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const rewrite = (path: string) => {
    if (!TEXT.has(extname(path))) return;
    const before = readFileSync(path, 'utf8');
    const after = before.replace(names, (name) => renamed.get(name) ?? name);
    if (after !== before) writeFileSync(path, after);
  };
  for (const [old, now] of renamed) renameSync(join(assets, old), join(assets, now));
  for (const entry of readdirSync(to, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) rewrite(join(entry.parentPath, entry.name));
  }

  const revision = createHash('md5').update(readFileSync(join(to, 'index.html'))).digest('hex');
  const worker = join(to, 'sw.js');
  const script = readFileSync(worker, 'utf8');
  const updated = script.replace(/(url:"\/",revision:")[0-9a-f]+(")/, `$1${revision}$2`);
  if (updated === script) throw new Error('sw.js has no start page entry (`/`) in its precache manifest to update');
  writeFileSync(worker, updated);
}
