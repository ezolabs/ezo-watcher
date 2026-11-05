#!/usr/bin/env node
// The `watcher` bin.
//
// An installed package (npm i -g --install-links github:ezolabs/ezo-watcher, a tarball, npx) lives under node_modules/,
// where Node refuses to strip TypeScript, so it runs the esbuild CLI bundle dist/cli/main.mjs. A repo
// checkout without a build runs src/cli/main.ts directly under Node's native type stripping: Node 24+
// (see `engines` in package.json) strips the strip-only subset, which is why src/ has no enums and no
// constructor parameter properties. Docker runs the server bundle (dist/server/main.mjs) on its own.

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const bundled = fileURLToPath(new URL('../dist/cli/main.mjs', import.meta.url))
const source = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url))

let cli
if (existsSync(bundled)) {
  cli = bundled
} else {
  const [major, minor] = process.versions.node.split('.').map(Number)
  // Type stripping is unflagged from 22.18 and 23.6; `engines` names Node 24 as the supported line.
  const stripsTypes = major > 24 || major === 24 || (major === 22 && minor >= 18) || (major === 23 && minor >= 6)
  if (!stripsTypes) {
    process.stderr.write(`watcher needs Node 22.18 or newer for native TypeScript type stripping (this is ${process.version}); Node 24 is the supported line.\nInstall Node 24: https://nodejs.org/en/download\n`)
    process.exit(1)
  }
  const server = fileURLToPath(new URL('../src/server/main.ts', import.meta.url))
  if (!existsSync(source)) {
    // A global git install made without --install-links on npm 11 leaves this whole package a symlink into
    // npm's cache temp clone, which npm deletes after the install: the bin is present but its sources are not.
    process.stderr.write(`watcher: the CLI source is missing at ${source}; reinstall the package (npm i -g --install-links github:ezolabs/ezo-watcher). If this bin is a symlink into npm's cache (_cacache/tmp/git-clone…), the install was made without --install-links and npm deleted the package behind it.\n`)
    process.exit(1)
  }
  if (!existsSync(server)) {
    process.stderr.write(`watcher: the server source is missing at ${server}; reinstall the package the same way (npm i -g --install-links github:ezolabs/ezo-watcher).\n`)
    process.exit(1)
  }
  cli = source
}

const cliModule = await import(pathToFileURL(cli).href)
process.exitCode = await cliModule.main(process.argv.slice(2))
