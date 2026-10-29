// npm run stack:access -- --login <name> — the sign-in of the stack tour /stack (server/http/stack.js). The password is typed
// hidden (or piped on stdin) and never given as an argument; the script prints the two lines for .env or Vercel
// (Settings → Environment Variables): STACK_LOGIN and STACK_PASSWORD_HASH. Nothing is written anywhere.
import { hashPassword } from '../server/adminAuth.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const fail = msg => { console.error(msg); process.exit(1); };

// Hidden prompt on a terminal; one line from stdin otherwise (as scripts/staff.js).
function ask(question) {
  if (!process.stdin.isTTY) return new Promise(ok => { let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => ok(s.split(/\r?\n/)[0].trim())); });
  return new Promise(ok => {
    const { stdin, stdout } = process;
    let s = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); return ok(s); }
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else if (ch >= ' ') s += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

const login = String(opt('login') || '').trim();
if (!/^[\w.-]{3,40}$/.test(login)) fail('Укажите --login (3–40 знаков: буквы, цифры, . _ -) / Give --login');
const password = await ask('Пароль / Password (≥ 8): ');
if (password.length < 8) fail('Не короче 8 знаков / At least 8 characters');
if (password.length > 200) fail('Слишком длинный / Too long');
if (password.toLowerCase().includes(login.toLowerCase())) fail('Пароль не должен содержать логин / The password must not contain the login');
if (process.stdin.isTTY && (await ask('Ещё раз / Again: ')) !== password) fail('Пароли не совпали / The passwords differ');

console.log(`\nSTACK_LOGIN=${login}\nSTACK_PASSWORD_HASH=${await hashPassword(password)}\n`);
console.log('Добавьте обе строки в .env (локально) или в Vercel → Settings → Environment Variables (Production), затем Redeploy.');
