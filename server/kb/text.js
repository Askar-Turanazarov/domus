// A question before the search (09 §5.1): Uzbek Cyrillic → Latin, the words that carry meaning, their stems.
const CYR_UZ = { щ: 'sh', ш: 'sh', ч: 'ch', ў: 'o‘', ғ: 'g‘', ҳ: 'h', қ: 'q', ё: 'yo', ю: 'yu', я: 'ya', ц: 'ts', ж: 'j', х: 'x', й: 'y',
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', з: 'z', и: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', э: 'e', ъ: '‘', ь: '', ы: 'i' };

const hasCyrillic = s => /[Ѐ-ӿ]/.test(s);

// The base in Uzbek is written in Latin, so a Cyrillic question is turned into Latin letter by letter.
export function uzToLatin(s) {
  return [...String(s)].map(ch => {
    const low = ch.toLowerCase();
    const to = CYR_UZ[low];
    if (to == null) return ch;
    return ch === low ? to : to.charAt(0).toUpperCase() + to.slice(1);
  }).join('');
}

// Words that do not count as a match (09 §5.3 «значимые слова»).
const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня ' +
  'еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ' +
  'ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда ' +
  'кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда ' +
  'можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя ' +
  'впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между какое какие ' +
  'the a an of to in is are was were be been do does did for on at by with and or not what when where how which who whom ' +
  'this that these those it its i you he she we they me my your our can could should would will there here from as ' +
  'bu va bilan uchun ham yoki emas nima qachon qayerda qanday qaysi kim men sen biz siz ular bor yoq yo‘q ni ning ga da dan ' +
  'бу ва билан учун ҳам ёки эмас нима қачон қаерда қандай қайси ким ').split(/\s+/).filter(Boolean));

export const words = s => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// A stem for the prefix search: the 'simple' dictionary does not know endings («сдача» ≠ «сдают»), so a long word is
// shortened by two letters (not below 4).
export const stem = w => (w.length > 5 ? w.slice(0, w.length - 2) : w);

// → { text (for the embedding), stems (significant words, deduplicated) }
export function prepare(query, lang, max = 500) {
  let text = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (lang === 'uz' && hasCyrillic(text)) text = uzToLatin(text);
  const stems = [...new Set(words(text).filter(w => w.length >= 3 && !STOP.has(w)).map(stem))];
  return { text, stems };
}

// A tsquery: stems with a prefix, any of them (the letters and digits only, so nothing can break the query).
export const tsOr = stems => stems.map(s => `'${s}':*`).join(' | ');

// How many of the stems occur in a text (as the beginning of one of its words).
export function matched(stems, ...texts) {
  const ws = words(texts.join(' '));
  return stems.filter(s => ws.some(w => w.startsWith(s))).length;
}
