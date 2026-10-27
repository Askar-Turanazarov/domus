// The manager password → ADMIN_PASSWORD_HASH (scrypt). The password itself is typed hidden and never stored.
//   npm run admin-password                 prints the line ADMIN_PASSWORD_HASH=…
//   npm run admin-password -- --save       also writes it into .env (replaces an old line)
//   npm run admin-password -- --vercel     also sets it in Vercel (production); then redeploy
// The password can also come from stdin (echo … | npm run admin-password), e.g. in scripts.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashPassword } from '../server/adminAuth.js';

const MIN = 10;
const has = flag => process.argv.includes(flag);

function ask(question) {
  if (!process.stdin.isTTY) return new Promise(ok => { let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => ok(s.trim())); });
  // Raw mode, nothing echoed: typed or pasted letters never reach the screen (readline internals differ by Node version).
  return new Promise(ok => {
    const { stdin, stdout } = process;
    let s = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          stdout.write('\n');
          return ok(s);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }   // Ctrl+C
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else if (ch >= ' ') s += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

(async () => {
  const pw = await ask('Пароль менеджера / Manager password: ');
  if (pw.length < MIN) { console.error(`Не короче ${MIN} символов / At least ${MIN} characters`); process.exit(1); }
  if (process.stdin.isTTY && (await ask('Ещё раз / Again: ')) !== pw) { console.error('Пароли не совпали / The passwords differ'); process.exit(1); }
  const line = `ADMIN_PASSWORD_HASH=${await hashPassword(pw)}`;
  console.log(line);

  if (has('--save')) {
    const file = path.join(import.meta.dirname, '..', '.env');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const kept = old.split(/\r?\n/).filter(l => !/^ADMIN_PASSWORD_HASH=/.test(l)).join('\n').replace(/\n*$/, '\n');
    fs.writeFileSync(file, (kept.trim() ? kept : '') + line + '\n');
    console.log('→ .env');
  }
  if (has('--vercel')) {
    const value = line.split('=')[1];
    // only the hash goes to the command line, never the password; --force replaces an old value,
    // NO_UPDATE_NOTIFIER — the CLI must not stop to ask about its own update
    execFileSync('npx', ['-y', 'vercel', 'env', 'add', 'ADMIN_PASSWORD_HASH', 'production', '--sensitive', '--force',
      '--value', value, '--yes', '--non-interactive'],
    { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32', env: { ...process.env, NO_UPDATE_NOTIFIER: '1' } });
    console.log('→ Vercel (production). Сделайте Redeploy / Redeploy to apply.');
  }
})();
