#!/usr/bin/env node
// The status-line tap runs many times a minute: import only what it needs.
if (process.argv[2] === 'statusline-tap') {
  const { runTap } = await import('../src/tap.js');
  // Whatever happens, the status line must not go blank because of us.
  await runTap().catch(() => {});
} else {
  const { main } = await import('../src/cli.js');
  main(process.argv).catch((err) => {
    console.error(`agentfdr: ${err.message}`);
    process.exit(1);
  });
}
