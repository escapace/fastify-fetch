import { exec as _exec } from 'node:child_process'
import { promisify } from 'node:util'
import { defineConfig, type Options } from 'tsup'
import { engines } from './package.json'
const exec = promisify(_exec)

export default defineConfig({
  clean: true,
  entry: ['src/index.ts'],
  format: 'esm',
  onSuccess: async () => {
    await exec(
      'pnpm exec tsc -p ./tsconfig-build.json --emitDeclarationOnly --declarationDir lib/types',
    )
  },
  outDir: 'lib/esm',
  outExtension() {
    return {
      js: '.mjs',
    }
  },
  sourcemap: true,
  splitting: true,
  target: [`node${engines.node.replace(/^\D+/, '')}`] as Options['target'],
})
