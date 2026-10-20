/** Run portable checks everywhere and POSIX service-helper checks on Linux. */
import { run } from './runtime.mjs'

const tests = ['project', 'control-contract', 'helper', 'private-files', 'self-heal']
if (process.platform === 'linux') tests.push('control-service')
else console.log('NOT_RUN Linux service-control tests: run this command on Linux')
run(process.execPath, ['--test', ...tests.map(name => `tests/${name}.test.mjs`)])
