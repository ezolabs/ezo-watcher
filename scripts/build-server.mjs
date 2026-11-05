// Bundle the server and the CLI into dist/, and the service worker next to the web build.
//
// bin/watcher.mjs imports dist/cli/main.mjs when it exists: an installed package lives under
// node_modules/, where Node refuses to strip TypeScript (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
// so the CLI has to ship as JavaScript. `watcher run` then imports dist/server/main.mjs by path, the
// same bundle Docker runs. src/ stays the only input, and a checkout without dist keeps executing the
// TypeScript sources directly under Node's native type stripping.
//
// Run with `--prepare` (package.json's `prepare` script) to also build the web bundle and to make the
// script work when it runs for a git dependency, where npm does not give the clone its devDependencies
// (see buildInScratch below).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const root = process.cwd()

/** Run a command; returns its exit status. */
function run(command, args, env = process.env, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env })
  return result.status ?? 1
}

/** Whether every bundle a package is expected to ship is present. */
function distComplete(dir = root) {
  return existsSync(join(dir, 'dist', 'cli', 'main.mjs')) &&
    existsSync(join(dir, 'dist', 'server', 'main.mjs')) &&
    existsSync(join(dir, 'dist', 'web', 'index.html'))
}

/**
 * Build in a copy of the package, then bring dist/ back.
 *
 * A git dependency (`npm i -g --install-links github:ezolabs/ezo-watcher`) is cloned into npm's cache and its `prepare`
 * runs there without node_modules: npm installs the clone's production dependencies into its own tree,
 * not into the clone, and an `npm install` run inside `prepare` races the npm process that is still
 * reifying that tree (`ENOTEMPTY`). So install the devDependencies in a scratch copy and build there;
 * the only thing written back is dist/, which npm is not touching.
 *
 * The `--install-links` in the documented command is not optional on npm 11.20: the prepare step runs as a nested
 * `npm install` in the clone with `npm_config_global` and `npm_config_prefix` inherited, so that nested install is a
 * global install of the clone itself, and with `install-links` off arborist reifies it as a symlink to the clone.
 * npm deletes the clone when the install ends, so `<prefix>/lib/node_modules/ezo-watcher` and `<prefix>/bin/watcher`
 * are left dangling. Any of prepare/prepack/build/install/postinstall triggers it, so a package with a build cannot
 * dodge it; the flag makes npm pack the prepared clone and install a real directory.
 */
function buildInScratch() {
  const scratch = mkdtempSync(join(tmpdir(), 'ezo-watcher-build-'))
  try {
    const skip = new Set(['node_modules', '.git', 'dist', '.tmp'])
    cpSync(root, scratch, { recursive: true, filter: (src) => !skip.has(basename(src)) })
    // A lockfile captured mid-install can be truncated; let npm resolve the same ranges on its own.
    rmSync(join(scratch, 'package-lock.json'), { force: true })
    const env = { ...process.env }
    for (const key of [
      'npm_config_global', 'npm_config_prefix', 'npm_config_force', 'npm_config_omit', 'npm_config_include',
      'npm_config_save', 'npm_config_package_lock_only', 'npm_config_package_lock', 'npm_config_dry_run',
      'npm_config_before', 'npm_config_offline', 'npm_config_prefer_offline', 'npm_config_prefer_online',
      'npm_config_install_links', 'npm_config_install_strategy'
    ]) delete env[key]
    const installed = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev', '--no-package-lock'], env, scratch)
    if (installed !== 0) return installed
    const vite = join(scratch, 'node_modules', 'vite', 'bin', 'vite.js')
    if (!existsSync(vite)) {
      process.stderr.write(`build: vite is missing at ${vite} after the scratch install.\n`)
      return 1
    }
    const web = run(process.execPath, [vite, 'build'], env, scratch)
    if (web !== 0) return web
    // The scratch copy's own build-server: bundles the server, the CLI and the service worker into scratch/dist.
    const bundles = run(process.execPath, [join(scratch, 'scripts', 'build-server.mjs')], env, scratch)
    if (bundles !== 0) return bundles
    if (!distComplete(scratch)) {
      process.stderr.write('build: the scratch build did not produce a complete dist/.\n')
      return 1
    }
    cpSync(join(scratch, 'dist'), join(root, 'dist'), { recursive: true })
    return 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv.includes('--prepare')) {
  // `prepare` runs in a checkout after npm installed the devDependencies, and up to twice for a git
  // dependency (once while npm is still installing the clone, once when the clone is packed). Build
  // where the tools are; an installed package ships a complete dist/ and has nothing to do.
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const esbuild = join(root, 'node_modules', 'esbuild', 'lib', 'main.js')
  if (existsSync(vite) && existsSync(esbuild)) {
    const web = run(process.execPath, [vite, 'build'])
    if (web !== 0) process.exit(web)
  } else if (distComplete()) {
    process.exit(0)
  } else {
    process.exit(buildInScratch())
  }
}

// Imported after the prepare branch above: a cloned git dependency has no esbuild in its own tree.
const { build } = await import('esbuild')

/** One shape for both Node bundles: ESM for Node 24, every runtime dependency bundled in, node: builtins external. */
function nodeBundle(entryPoint, outfile) {
  return {
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['node:*'],
    sourcemap: false,
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'info'
  }
}

await build(nodeBundle('src/server/main.ts', 'dist/server/main.mjs'))

await build(nodeBundle('src/cli/main.ts', 'dist/cli/main.mjs'))

await build({
  entryPoints: ['src/web/sw.ts'],
  outfile: 'dist/web/sw.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2023',
  minify: true,
  logLevel: 'info'
})
