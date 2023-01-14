import fse from 'fs-extra'
import path from 'path'
import process from 'process'
import semver from 'semver'
import arg from 'arg'
import { execa } from 'execa'

const error = (message) => {
  console.error(message)

  process.exit(1)
}

async function main() {
  const args = arg({
    '--dry-run': Boolean
  })

  let version = args._[0]

  if (!version) {
    error('No version specified')
  }

  if (!semver.valid(version)) {
    error(`Incorrect version "${version}"`)
  }

  version = semver.clean(version)

  const packageJsonPath = path.join(process.cwd(), 'package.json')

  const packageJson = await fse.readJson(packageJsonPath)

  if (packageJson.version === version) {
    error(
      `Package version from "${version}" matches the current version "${packageJson.version}"`
    )
  }

  console.log(`Releasing ${packageJson.name}@${version}`)

  fse.writeJSON(packageJsonPath, { ...packageJson, version })

  await execa('pnpm', [
    'exec',
    'syncpack',
    'format',
    '--source',
    packageJsonPath
  ])

  await execa('pnpm', ['run', 'build'])

  await execa(
    'pnpm',
    [
      'publish',
      '--no-git-checks',
      '--access',
      'public',
      '--publish-branch',
      'trunk',
      args['--dry-run'] ? '--dry-run' : undefined
    ].filter((value) => value !== undefined)
  )
}

main()
