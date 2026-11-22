import { existsSync } from 'node:fs'
process.exit(existsSync(process.argv[2]) ? 0 : 1)
