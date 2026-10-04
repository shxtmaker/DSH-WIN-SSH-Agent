/** Process launchers shared by the standalone build and test commands. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { readFile } from 'node:fs/promises'

export const root = resolve(import.meta.dirname, '..')
export const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))

export function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, shell: false, windowsHide: true, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`)
}

export function pnpm(args, cwd) {
  if (process.platform === 'win32') {
    const launcher = join(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js')
    if (!existsSync(launcher)) throw new Error('Corepack must be installed beside Node.js')
    run(process.execPath, [launcher, 'pnpm', ...args], cwd)
  } else run('corepack', ['pnpm', ...args], cwd)
}

export function workspace(value = '.build/upstream') {
  const target = resolve(root, value)
  const within = relative(root, target)
  if (isAbsolute(within) || !within.startsWith(`.build${sep}`)) throw new Error('Workspace must be inside .build/')
  return target
}
