/** Execute the role's integration checks in its own prepared Harness workspace. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { root, project, pnpm, run, workspace } from './runtime.mjs'

const { values } = parseArgs({ options: { workspace: { type: 'string' } } })
const target = workspace(values.workspace)
const identity = JSON.parse(await readFile(join(target, '.dsh-split-project.json'), 'utf8'))
if (identity.role !== project.role) throw new Error('Workspace belongs to a different project')
if (project.role === 'controller') {
  pnpm(['exec', 'vitest', 'run', 'packages/remote/controller/tests/proxy.spec.ts', 'packages/remote/controller/tests/loader-composition.spec.ts', '--reporter=dot'], target)
} else run(process.execPath, ['--test', join(root, 'tests/helper.test.mjs'), join(root, 'tests/private-files.test.mjs')])
