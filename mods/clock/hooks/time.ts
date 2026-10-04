// Calendar days and the week ranges Clock hands Claude, in the person's own
// timezone, and the check of a reply's dates against the period asked for.

export type Day = { y: number; m: number; d: number }
export type Range = { from: Day; to: Day }
export type Period = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// A place whose local time a folder's work depends on, from ~/.claude/clock/markets.json.
export type Market = { label: string; place: string; zone: string }
export type MarketsByFolder = { folder: string; markets: Market[] }[]

export const MARKETS_FILE = '.claude/clock/markets.json'

// The markets for a folder: every entry whose folder the path contains.
export function marketsFor(config: unknown, cwd: string): Market[] {
  if (!Array.isArray(config)) {
    return []
  }

  return (config as MarketsByFolder)
    .filter(entry => typeof entry?.folder === 'string' && cwd.includes(entry.folder) && Array.isArray(entry.markets))
    .flatMap(entry => entry.markets.filter(market => typeof market?.zone === 'string' && typeof market?.label === 'string'))
}

export const serial = (day: Day): number => Date.UTC(day.y, day.m - 1, day.d) / 86_400_000

export function dayOf(n: number): Day {
  const date = new Date(n * 86_400_000)

  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
}

// Monday 0 … Sunday 6.
export const weekday = (day: Day): number => (new Date(serial(day) * 86_400_000).getUTCDay() + 6) % 7

// The wall clock in a zone: its day, time and offset from UTC.
export function wallClock(now: number, zone: string): { day: Day; hh: number; mm: number; offset: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now))
      .map(part => [part.type, part.value]),
  )
  const day = { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) }
  const hh = Number(parts.hour)
  const mm = Number(parts.minute)
  const asUtc = Date.UTC(day.y, day.m - 1, day.d, hh, mm)
  const offset = Math.round((asUtc - Math.floor(now / 60_000) * 60_000) / 60_000)

  return { day, hh, mm, offset }
}

const shift = (day: Day, days: number): Day => dayOf(serial(day) + days)

export function rangeOf(period: Period, today: Day): Range {
  const monday = shift(today, -weekday(today))

  switch (period) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday':
      return { from: shift(today, -1), to: shift(today, -1) }
    case 'thisWeek':
      return { from: monday, to: shift(monday, 6) }
    // On a weekend, "last week" is the work week that just ended.
    case 'lastWeek':
      return weekday(today) >= 5 ? { from: monday, to: shift(monday, 4) } : { from: shift(monday, -7), to: shift(monday, -3) }
    case 'thisMonth':
      return { from: { ...today, d: 1 }, to: shift({ y: today.m === 12 ? today.y + 1 : today.y, m: (today.m % 12) + 1, d: 1 }, -1) }
    case 'lastMonth': {
      const first = { ...today, d: 1 }
      const end = shift(first, -1)

      return { from: { ...end, d: 1 }, to: end }
    }
  }
}

const short = (day: Day): string => `${MONTHS[day.m - 1]?.slice(0, 3)} ${day.d}`
const dayName = (day: Day): string => WEEKDAYS[weekday(day)]?.slice(0, 3) ?? ''

// "Sep 28 – Oct 2", "Aug 10–14", "Oct 4".
export function showRange(range: Range): string {
  if (serial(range.from) === serial(range.to)) {
    return short(range.from)
  }

  if (range.from.m === range.to.m && range.from.y === range.to.y) {
    return `${short(range.from)}–${range.to.d}`
  }

  return `${short(range.from)} – ${short(range.to)}`
}

const longDay = (day: Day): string => `${WEEKDAYS[weekday(day)]}, ${day.d} ${MONTHS[day.m - 1]} ${day.y}`
const pad = (n: number): string => String(n).padStart(2, '0')

function showOffset(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+'
  const abs = Math.abs(minutes)

  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const withDays = (range: Range): string => `${dayName(range.from)} ${showRange(range)}${serial(range.from) === serial(range.to) ? '' : ` (${dayName(range.to)})`}, ${range.to.y}`

// What rides beside each prompt.
export function brief(now: number, zone: string, markets: Market[]): string {
  const here = wallClock(now, zone)
  const today = here.day
  const calendarLastWeek = { from: shift(today, -weekday(today) - 7), to: shift(today, -weekday(today) - 1) }
  const isWeekend = weekday(today) >= 5

  const lines = [
    "Clock, from the person's computer:",
    `- Now: ${longDay(today)}, ${pad(here.hh)}:${pad(here.mm)} (${showOffset(here.offset)})`,
    `- Yesterday: ${longDay(shift(today, -1))}`,
    `- This week: ${withDays(rangeOf('thisWeek', today))}; work days ${showRange({ from: rangeOf('thisWeek', today).from, to: shift(rangeOf('thisWeek', today).from, 4) })}`,
    isWeekend
      ? `- "Last week", as the person means it on a weekend: ${withDays(rangeOf('lastWeek', today))}, the work week that just ended. The calendar week before it: ${showRange(calendarLastWeek)}`
      : `- Last week: work days ${withDays(rangeOf('lastWeek', today))}; calendar week ${showRange(calendarLastWeek)}`,
    `- This month: ${MONTHS[today.m - 1]} ${today.y}. Last month: ${MONTHS[rangeOf('lastMonth', today).from.m - 1]} ${rangeOf('lastMonth', today).from.y}`,
  ]

  if (markets.length > 0) {
    const times = markets.map(market => {
      const there = wallClock(now, market.zone)

      return `${market.label}${market.place ? ` (${market.place})` : ''} ${dayName(there.day)} ${short(there.day)} ${pad(there.hh)}:${pad(there.mm)}`
    })
    lines.push(`- Markets now: ${times.join(' · ')}`)
  }

  lines.push(
    'Take dates from here instead of working them out. Keep city and timezone names out of titles, labels, headings and file names unless the person asks for them.',
  )

  return lines.join('\n')
}

const ASKED: [Period, RegExp][] = [
  ['lastWeek', /\b(last|previous|past) week\b|прошл[а-яё]* недел|за недел/i],
  ['thisWeek', /\bthis week\b|эт[а-яё]* недел|текущ[а-яё]* недел/i],
  ['lastMonth', /\b(last|previous|past) month\b|прошл[а-яё]* месяц/i],
  ['thisMonth', /\bthis month\b|эт[а-яё]* месяц|текущ[а-яё]* месяц/i],
  ['yesterday', /\byesterday\b|вчера/i],
  ['today', /\btoday\b|сегодня/i],
]

export function periodAsked(text: string): Period | undefined {
  return ASKED.find(([, pattern]) => pattern.test(text))?.[0]
}

const MONTH_PATTERN =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])'
const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function monthOf(word: string): number {
  const w = word.toLowerCase()
  const en = EN_MONTHS.findIndex(prefix => w.startsWith(prefix))

  return en >= 0 ? en + 1 : RU_MONTHS.findIndex(prefix => w.startsWith(prefix)) + 1
}

// A month and day with no year: the year that puts it nearest today.
function near(m: number, d: number, today: Day): Day {
  const candidates = [today.y - 1, today.y, today.y + 1].map(y => ({ y, m, d }))

  return candidates.reduce((best, day) => (Math.abs(serial(day) - serial(today)) < Math.abs(serial(best) - serial(today)) ? day : best))
}

const DASH = '\\s*(?:-|–|—|to|по|до)\\s*'

// Every calendar date a reply names, ranges spread to both ends.
export function datesIn(text: string, today: Day): Day[] {
  const found: Day[] = []
  const valid = (day: Day): boolean => day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= 31
  const add = (day: Day) => valid(day) && found.push(day)
  let rest = text

  const take = (pattern: RegExp, read: (match: RegExpExecArray) => void) => {
    rest = rest.replace(pattern, (...args) => {
      read(args.slice(0, -2) as unknown as RegExpExecArray)

      return ' '
    })
  }

  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, m => add({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }))
  take(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, m => add({ y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) }))
  // 28 Sep – 2 Oct; Sep 28 – Oct 2
  take(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_PATTERN}(?![a-zа-яё])\\.?${DASH}(\\d{1,2})\\s+${MONTH_PATTERN}(?![a-zа-яё])`, 'gi'), m => {
    add(near(monthOf(m[2] ?? ''), Number(m[1]), today))
    add(near(monthOf(m[4] ?? ''), Number(m[3]), today))
  })
  take(new RegExp(`(?<![a-zа-яё])${MONTH_PATTERN}\\.?\\s+(\\d{1,2})${DASH}${MONTH_PATTERN}(?![a-zа-яё])\\.?\\s+(\\d{1,2})\\b`, 'gi'), m => {
    add(near(monthOf(m[1] ?? ''), Number(m[2]), today))
    add(near(monthOf(m[3] ?? ''), Number(m[4]), today))
  })
  // 10–14 August; Aug 10–14
  take(new RegExp(`\\b(\\d{1,2})${DASH}(\\d{1,2})\\s+${MONTH_PATTERN}(?![a-zа-яё])`, 'gi'), m => {
    add(near(monthOf(m[3] ?? ''), Number(m[1]), today))
    add(near(monthOf(m[3] ?? ''), Number(m[2]), today))
  })
  take(new RegExp(`(?<![a-zа-яё])${MONTH_PATTERN}\\.?\\s+(\\d{1,2})${DASH}(\\d{1,2})\\b`, 'gi'), m => {
    add(near(monthOf(m[1] ?? ''), Number(m[2]), today))
    add(near(monthOf(m[1] ?? ''), Number(m[3]), today))
  })
  // 14 August; Aug 14
  take(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_PATTERN}(?![a-zа-яё])`, 'gi'), m => add(near(monthOf(m[2] ?? ''), Number(m[1]), today)))
  take(new RegExp(`(?<![a-zа-яё])${MONTH_PATTERN}\\.?\\s+(\\d{1,2})\\b`, 'gi'), m => add(near(monthOf(m[1] ?? ''), Number(m[2]), today)))

  return found
}

// The footnote for a reply whose dates all miss the period asked for, if any.
export function mismatch(period: Period, answer: string, today: Day): string | undefined {
  const dates = datesIn(answer, today)

  if (dates.length === 0) {
    return undefined
  }

  const expected = rangeOf(period, today)
  // A week asked for counts its whole calendar week; a day or month is exact.
  const isWeek = period === 'thisWeek' || period === 'lastWeek'
  const from = isWeek ? serial(expected.from) - weekday(expected.from) : serial(expected.from)
  const to = isWeek ? from + 6 : serial(expected.to)

  if (dates.some(day => serial(day) >= from && serial(day) <= to)) {
    return undefined
  }

  const sorted = [...dates].sort((a, b) => serial(a) - serial(b))
  const said = showRange({ from: sorted[0] as Day, to: sorted.at(-1) as Day })
  const name = { today: 'Today is', yesterday: 'Yesterday was', thisWeek: 'This week is', lastWeek: 'Last week was', thisMonth: 'This month is', lastMonth: 'Last month was' }[period]

  return `${name} ${showRange(expected)}. This reply says ${said}`
}

export function anchorOf(text: string): string {
  return text.trim().slice(-160)
}

// The last text block of a reply ends where the turn's answer ends.
export function isUnder(anchor: string, blockText: string): boolean {
  const block = anchorOf(blockText)

  return block.length >= 12 && anchor.endsWith(block.slice(-Math.min(block.length, 80)))
}
