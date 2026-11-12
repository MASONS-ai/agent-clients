#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { CONFIG } from './build-config.mjs';
import { Owner, settings } from './owner.mjs';

const owner = new Owner(CONFIG), action = process.argv[2] ?? 'status';
try {
  if (action === 'status') {
    const held = settings(owner.store);
    console.log(JSON.stringify({ channel: CONFIG.channel, link: held.credential ? 'linked' : held.candidate ? 'setup_pending' : 'not_linked', pending: held.candidate?.state ?? null }));
  } else if (action === 'poll') {
    const held = settings(owner.store);
    console.log(JSON.stringify(held.candidate?.state === 'received' ? await owner.qualify() : await owner.poll()));
  } else if (action === 'link' || action === 'cancel') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this owner command in an interactive terminal. The model cannot confirm Link.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const before = settings(owner.store);
    let answer; try { answer = await prompt.question(`${action === 'link' ? 'Link this OMP installation' : 'Cancel the pending Link'} on ${CONFIG.label}? Type ${action} to confirm: `); } finally { prompt.close(); }
    if (answer !== action) console.log(JSON.stringify({ status: 'cancelled' }));
    else if (action === 'cancel') console.log(JSON.stringify(owner.cancel(before.candidate?.id)));
    else console.log(JSON.stringify(await owner.begin(process.argv[3])));
  } else throw new Error('Usage: node setup.mjs status | link [@handle] | poll | cancel');
} catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
