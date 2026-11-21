// Entry point: the handshake between this forge and the trial environment.
//
// The forge itself lives in app.ts. This file only runs the little dance the
// harness expects, in order: learn where the environment listens, start the
// server on a port the kernel picks, tell the environment that port, then
// keep asking whether the trial is finished until it says so. The process
// leaves only when the environment says the trial is done, or when something
// in this handshake fails outright.
//
// Nothing here touches the store or the request handling. Keeping the
// handshake in one short file means a broken trial setup fails fast, before
// any check runs, instead of hanging the whole run.

import { createApp } from './app.ts';

// Where the trial environment answers. The harness sets this; without it
// there is nobody to register with, so there is no point starting the server.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is empty, so the trial environment cannot be reached\n');
  process.exit(1);
}

// One request gets thirty seconds before it counts as failed; a failed
// request waits a little before the next try, doubling each time up to two
// seconds. The doubling stops growing after eight failures, so the wait
// settles at the two-second cap.
const REQUEST_BUDGET_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;
const BACKOFF_STEPS = 8;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long to wait after `failures` failed attempts: double from the start
// value, capped at the limit.
function nextPause(failures: number): number {
  const doubled = BACKOFF_START_MS * 2 ** Math.min(failures, BACKOFF_STEPS);
  return doubled > BACKOFF_LIMIT_MS ? BACKOFF_LIMIT_MS : doubled;
}

// Tell the environment which port the forge bound. A 200 means the port was
// recorded; a 409 means another entry registered first and this one simply
// waits like any other. A 400 or 405 means the request itself was wrong, so
// retrying would never help and the process fails. Anything else — the
// environment still starting, a dropped connection, an odd status — is worth
// another try after a pause.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let answer: Response;
    try {
      answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      await pause(nextPause(failures));
      failures += 1;
      continue;
    }
    if (answer.status === 200 || answer.status === 409) return;
    if (answer.status === 400 || answer.status === 405) {
      throw new Error(`register rejected with HTTP ${answer.status}: ${await answer.text()}`);
    }
    await pause(nextPause(failures));
    failures += 1;
  }
}

// Ask the environment whether the trial has finished, over and over, until
// it answers { done: true }. The environment answers right away either way,
// so this is a poll: a slow or failed request, or an answer that is not
// done yet, just means waiting a little longer.
async function awaitFinished(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const answer = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Unreachable, timed out, or an unreadable answer: not done yet.
    }
    await pause(nextPause(failures));
    failures += 1;
  }
}

// Start the forge, register its port, then wait for the trial to end. That
// is the whole life of this process.
async function boot(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((ok, fail) => {
    forge.once('error', fail);
    forge.listen(0, () => ok());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the trial to finish\n');

  await awaitFinished();
  forge.close();
  process.stdout.write('[entry] trial finished, closing down\n');
}

try {
  await boot();
  process.exit(0);
} catch (failure) {
  process.stderr.write(`[entry] failed: ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exit(1);
}
