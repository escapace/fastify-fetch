import { build } from 'esbuild'
import fastGlob from 'fast-glob'
import { remove } from 'fs-extra'
import { mkdir } from 'fs/promises'
import path from 'path'
import { cwd, external, packageJSON, target } from './constants.mjs'

const directoryTests = path.join(cwd, 'lib/tests')
const directorySrc = path.join(cwd, 'src')

process.umask(0o022)
process.chdir(cwd)

await remove(directoryTests)
await mkdir(directoryTests, { recursive: true })

const entryPoints = await fastGlob(['**/*.spec.?(m)(j|t)s?(x)'], {
  absolute: true,
  cwd: directorySrc,
  dot: true
})

await build({
  bundle: true,
  entryPoints,
  external: [
    ...external,
    ...Object.keys(packageJSON.devDependencies ?? {})
  ],
  format: 'esm',
  logLevel: 'info',
  outbase: directorySrc,
  outdir: directoryTests,
  platform: 'node',
  sourcemap: true,
  target
})

