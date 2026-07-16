import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = createInterface({ input, output });

const commands = [
  'создай файл repl-test.txt с текстом hello',
  'что внутри файла?',
  '/exit',
];

let i = 0;
async function sendNext() {
  if (i < commands.length) {
    const cmd = commands[i++];
    console.log(`\n>>> ${cmd}`);
    rl.write(cmd + '\n');
  }
}

rl.on('line', () => {
  setTimeout(sendNext, 500);
});

sendNext();
