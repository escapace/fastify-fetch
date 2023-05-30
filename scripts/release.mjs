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
    '--dry-run': Boolean,
    '--access': String
  })

  let version = args._[0]

  if (!version) {
    error('No version specified')
  }

  if (!semver.valid(version)) {
    error(`Incorrect version "${version}"`)
  }

  const access = args['--access'] ?? 'public'

  if (!['public', 'restricted'].includes(access)) {
    throw new Error(`Access should be either 'public' or 'restricted'.`)
  }

  version = semver.clean(version)

  const packageJsonPath = path.join(process.cwd(), 'package.json')

  const packageJson = await fse.readJson(packageJsonPath)

  console.log(`Releasing ${packageJson.name}@${version}`)

  fse.writeJSON(packageJsonPath, { ...packageJson, version })

  await execa('pnpm', [
    'exec',
    'syncpack',
    'format',
    '--source',
    packageJsonPath
  ])

  await execa(
    'npm',
    [
      'publish',
      '--provenance',
      '--access',
      access,
      args['--dry-run'] ? '--dry-run' : undefined
    ].filter((value) => value !== undefined)
  )
}

main()
