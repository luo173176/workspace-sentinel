import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [pidFile] = process.argv.slice(2)
const child = spawn(process.execPath, [fileURLToPath(new URL('./verify-tree-child.js', import.meta.url))], {
  stdio: 'ignore',
})
writeFileSync(pidFile, String(child.pid))
process.exit(1)
