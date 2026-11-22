process.on('SIGTERM', () => {
  // Deliberately ignore a graceful stop so the verification timeout must escalate.
})
setTimeout(() => process.exit(0), 1_500)
