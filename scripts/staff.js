// npm run staff -- <command> — staff accounts (02 §3.2, 12 §10.3, 14 §2.1). The password is typed hidden (or piped on stdin) and
// never given as an argument.
//   add --login aziz --name "Азиз" --role manager|head [--lang ru|uz|en]    new account
//   passwd --login aziz          new password; the open sessions of the person end
//   logout-all --login aziz      end the open sessions
//   disable|enable --login aziz
//   role --login aziz --role head
//   list
// Production base: add --yes (scripts/dbTarget.js).
import { openTarget } from './dbTarget.js';
import { migrate } from '../server/db/migrate.js';
import { hashPassword } from '../server/adminAuth.js';
import { createStaff, staffByLogin, listStaff, setPassword, logoutEverywhere, setActive, setRole, weakPassword } from '../server/core/staff.js';

const args = process.argv.slice(2);
const [command] = args;
const opt = name => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const fail = msg => { console.error(msg); process.exit(1); };

// Hidden prompt on a terminal; one line from stdin otherwise.
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

async function newPassword(login) {
  const pw = await ask('Пароль / Password (≥ 12): ');
  const bad = weakPassword(pw, login);
  if (bad) fail({ short: 'Не короче 12 знаков / At least 12 characters', long: 'Слишком длинный / Too long',
    common: 'Слишком простой пароль / Too common', login: 'Пароль содержит логин / The password contains the login' }[bad]);
  if (process.stdin.isTTY && (await ask('Ещё раз / Again: ')) !== pw) fail('Пароли не совпали / The passwords differ');
  return hashPassword(pw);
}

if (!['add', 'passwd', 'logout-all', 'disable', 'enable', 'role', 'list'].includes(command)) {
  fail('Команды / Commands: add, passwd, logout-all, disable, enable, role, list (см. шапку scripts/staff.js)');
}

const db = openTarget(args);
try {
  const ready = await db.ready();
  if (db.kind === 'pglite') await migrate(ready);
  if (command === 'list') {
    for (const s of await listStaff(ready)) {
      console.log(`${s.login}\t${s.name}\t${s.role}\t${s.active ? 'active' : 'disabled'}\t${s.telegram_user_id ? 'telegram' : '-'}\tlast ${s.last_login_at?.toISOString?.() ?? '-'}`);
    }
  } else if (command === 'add') {
    const role = opt('role');
    if (!opt('login') || !opt('name') || !['manager', 'head'].includes(role)) fail('add --login <login> --name "<name>" --role manager|head');
    if (await staffByLogin(ready, opt('login'))) fail('Такой логин уже есть / The login exists');
    const s = await createStaff(ready, { login: opt('login'), name: opt('name'), role, lang: opt('lang') ?? 'ru', passwordHash: await newPassword(opt('login')) });
    console.log(`Created: ${s.login} (${s.role})`);
  } else {
    const s = await staffByLogin(ready, opt('login'));
    if (!s) fail('Нет такого логина / No such login');
    if (command === 'passwd') await setPassword(ready, s.id, await newPassword(s.login));
    if (command === 'logout-all') await logoutEverywhere(ready, s.id);
    if (command === 'disable') await setActive(ready, s.id, false);
    if (command === 'enable') await setActive(ready, s.id, true);
    if (command === 'role') await setRole(ready, s.id, opt('role'));
    console.log(`${command}: ${s.login} ok`);
  }
} finally { await db.close(); }
