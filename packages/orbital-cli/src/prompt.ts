/**
 * Console prompts for the CLI/wizard.
 *
 * Hidden input uses raw terminal mode so secrets never echo back. Piped
 * input (scripted/smoke usage) goes through ONE shared line queue: creating
 * separate readline interfaces per prompt would race on the same stream and
 * swallow buffered lines.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const lineQueue: string[] = [];
let partial = "";
let draining = false;

function drainStdin(): void {
  if (draining) {
    return;
  }

  draining = true;
  stdin.resume();
  stdin.on("data", (chunk: Buffer) => {
    partial += chunk.toString("utf8");

    let newlineIndex = partial.indexOf("\n");

    while (newlineIndex !== -1) {
      lineQueue.push(partial.slice(0, newlineIndex).replace(/\r$/, ""));
      partial = partial.slice(newlineIndex + 1);
      newlineIndex = partial.indexOf("\n");
    }
  });
}

function nextQueuedLine(): Promise<string> {
  const queued = (): boolean => lineQueue.length > 0;

  if (queued()) {
    return Promise.resolve(lineQueue.shift() ?? "");
  }

  drainStdin();

  return new Promise((resolvePromise) => {
    const check = (): void => {
      if (queued()) {
        stdin.removeListener("data", check);
        resolvePromise(lineQueue.shift() ?? "");
      }
    };

    stdin.on("data", check);
    check();
  });
}

async function readLine(question: string): Promise<string> {
  stdout.write(question);

  const line = await nextQueuedLine();

  stdout.write("\n");

  return line.trim();
}

export async function ask(question: string): Promise<string> {
  if (!stdin.isTTY) {
    return readLine(question);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) {
    return readLine(question);
  }

  return new Promise((resolvePromise) => {
    stdout.write(question);

    const chars: string[] = [];
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdout.write("\n");
    };

    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolvePromise(chars.join(""));

          return;
        }

        if (char === "\u0003") {
          // Ctrl+C: restore the terminal before dying.
          cleanup();
          process.exit(130);
        }

        if (char === "\u007f" || char === "\b") {
          chars.pop();
        } else if (char !== "") {
          chars.push(char);
        }
      }
    };

    stdin.on("data", onData);
  });
}
