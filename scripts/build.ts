import { build, type BuildOptions } from 'esroll'
import { exec as _exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(_exec)

const dirname = path.resolve(import.meta.dirname, '../')
process.chdir(dirname)

const packageJSON = JSON.parse(await readFile(path.join(dirname, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>
  version: string
}

const constants = JSON.parse(
  await readFile(path.join(import.meta.dirname, 'constants.json'), 'utf-8'),
) as {
  builds: Record<string, BuildOptions>
}

for (const value of Object.values(constants.builds)) {
  await build({
    absWorkingDir: dirname,
    external: Object.keys(packageJSON.dependencies ?? []),
    sourcemap: true,
    sourcesContent: false,
    splitting: true,
    treeShaking: true,
    tsconfig: 'tsconfig-build.json',
    ...value,
    define: {
      __VERSION__: JSON.stringify(packageJSON.version),
      ...value.define,
    },
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

await exec(
  'pnpm exec tsc -p ./tsconfig-build.json --emitDeclarationOnly --declarationDir lib/types',
)
