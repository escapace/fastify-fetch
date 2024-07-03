import { defineConfig, mergeConfig } from 'vitest/config'
import { version } from './package.json'
import { builds } from './scripts/constants.json'
import configShared from './vitest.config'

export default mergeConfig(
  configShared,
  defineConfig({
    define: {
      ...builds.node.define,
      __VERSION__: JSON.stringify(version),
    },
    esbuild: {
      platform: 'node',
      target: builds.node.target,
    },
    test: {
      environment: 'node',
      include: ['{src,tests}/**/+([a-zA-Z0-9-])?(.node).{test,spec}.?(c|m)[jt]s?(x)'],
      name: 'node',
      sequence: {
        hooks: 'list',
      },
    },
  }),
)
