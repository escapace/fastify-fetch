import { build, type BuildOptions } from 'esroll'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const dirname = path.resolve(import.meta.dirname, '../')
process.chdir(dirname)

const packageJSON = JSON.parse(await readFile(path.join(dirname, 'package.json'), 'utf-8')) as {
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const constants = JSON.parse(
  await readFile(path.join(import.meta.dirname, 'constants.json'), 'utf-8'),
) as {
  builds: Record<string, BuildOptions>
  declaration?: BuildOptions
}

for (const value of Object.values(constants.builds)) {
  await build({
    sourcemap: true,
    sourcesContent: false,
    splitting: true,
    treeShaking: true,
    tsconfig: 'tsconfig-build.json',
    ...value,
    absWorkingDir: dirname,
    define: {
      __VERSION__: JSON.stringify(packageJSON.version),
      ...value.define,
    },
    external: [
      ...Object.keys(packageJSON.dependencies ?? []),
      ...Object.keys(packageJSON.peerDependencies ?? []),
      ...(value.external ?? []),
    ],
    rollup: {
      experimentalLogSideEffects: true,
      ...value.rollup,
    },
    supported: {
      'const-and-let': true,
      ...value.supported,
    },
  })
}

if (constants.declaration !== undefined) {
  await build({
    declaration: true,
    ...constants.declaration,
  })
}
