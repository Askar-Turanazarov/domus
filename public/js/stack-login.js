// The sign-in form of /stack (pages/stack/login.html, server/http/stack.js): its own login and password, not a staff account.
// A good answer sets the cookie and the page reloads into the tour.
import { initTheme } from './theme.js';

const T = {
  ru: { planner: 'Планировщик', building: 'Новостройка', title: 'Как устроен Domus', sub: 'Закрытая страница. Введите логин и пароль.',
    login: 'Логин', password: 'Пароль', enter: 'Войти', bad: 'Логин или пароль неверны', many: 'Слишком много попыток — повторите через 15 минут',
    closed: 'Страница пока закрыта: доступ не настроен', net: 'Нет связи с сервером' },
  uz: { planner: 'Rejalashtiruvchi', building: 'Yangi bino', title: 'Domus qanday tuzilgan', sub: 'Yopiq sahifa. Login va parolni kiriting.',
    login: 'Login', password: 'Parol', enter: 'Kirish', bad: 'Login yoki parol noto‘g‘ri', many: 'Urinishlar juda ko‘p — 15 daqiqadan so‘ng qayta urinib ko‘ring',
    closed: 'Sahifa hozircha yopiq: kirish sozlanmagan', net: 'Server bilan aloqa yo‘q' },
  en: { planner: 'Planner', building: 'New building', title: 'How Domus is built', sub: 'A private page. Enter the login and password.',
    login: 'Login', password: 'Password', enter: 'Sign in', bad: 'Wrong login or password', many: 'Too many attempts — try again in 15 minutes',
    closed: 'The page is closed for now: access is not set up', net: 'No connection to the server' }
};
const LANGS = ['ru', 'uz', 'en'];
let lang = (() => { try { const l = localStorage.getItem('fsp3d.lang'); return LANGS.includes(l) ? l : 'ru'; } catch { return 'ru'; } })();

function apply() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = T[lang][el.dataset.t];
  for (const a of document.querySelectorAll('[data-href]')) a.href = `/${lang}${a.dataset.href}`;
  for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('active', b.dataset.lang === lang);
}
for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => {
  lang = b.dataset.lang;
  try { localStorage.setItem('fsp3d.lang', lang); } catch { /* storage unavailable */ }
  apply();
});
initTheme();
apply();

const form = document.getElementById('skLogin'), err = document.getElementById('skErr');
form.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  err.textContent = '';
  try {
    const res = await fetch('/api/stack/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'domus-stack' },
      body: JSON.stringify({ login: form.username.value, password: form.password.value }) });
    if (res.ok) return location.reload();
    err.textContent = T[lang][res.status === 429 ? 'many' : res.status === 503 ? 'closed' : 'bad'];
  } catch {
    err.textContent = T[lang].net;
  }
  btn.disabled = false;
});
