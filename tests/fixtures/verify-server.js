import { writeFileSync } from 'node:fs'

const [pidFile, readyFile, makeReady] = process.argv.slice(2)
writeFileSync(pidFile, String(process.pid))
if (makeReady === 'yes') {
  setTimeout(() => writeFileSync(readyFile, 'ready'), 50)
}
setInterval(() => {}, 1_000)
