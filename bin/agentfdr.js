#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv).catch((err) => {
  console.error(`agentfdr: ${err.message}`);
  process.exit(1);
});
