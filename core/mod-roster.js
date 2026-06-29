'use strict'

// Lifeboat staff/mod gamertags from TRV ModWarning (normalized lowercase).
const STAFF_MODS = new Set([
  'itzrubyrose2', 'xyunami', 'itznotrust1', 'modulo 7', 'issmyt', 'mobfox',
  'snow flow7010', 'my1legocraft', 'xpandaladyx', 'holydeesus', 'itsjustclar',
  'mootburrito9652', 'slilvy', 'liquidrhyx', 'oreoaxolotl1', 'sloopykatie',
  'duckymuffins', 'geewhiizz', 'eeviumm', 'dozaivv', 'mylo20032868',
  'clubamericas', 'lazinesses', 'zblqde1654', 'kingk6316', 'redheadgamer314',
  'mightypieajr', 'shgru', 'ineptsky3255696', 'mapajama', 'itzoreox',
  'unova1111', 'lcdestroysu', 'a1frostbite0100', 'puggy231', 'itzmay3173',
  'critly6084', 'notranean', 'watermelon5418', 'tanmanstyle', 'p0qsicle',
  'bassbump8', 'allied forc3', 'silverstream688', 'ashara fos', 'izukudekumha',
  'xxdrxtexxx', 'cookiechaos323', 'wizard101', 'jolie morenita', 'al4la',
  'mr blue ii', 'hheavennleaa', 'misqkii', 'x0cyn', 'gps82017', 'sasuqkeet',
  'qqlucaspq', 'kittykristyy', 'simouxgboss', 'delusionaltoed', 'mydadcraft',
  'mrdestrot', 'rapidhitz', 'ikzslayerxpvp', 'shiny skelly', 'hydreongamer',
  'lumithepotat', 'kuba7747', 'xbon 27', 'pandemia uwu', 'necryii', 'hydreon',
  'casecrown', 'rabidfly', 'soturi/crusad3r', 'w1ngher0', 'lunnarosse',
  'angqls x', 'necrii', 'empneon', 'xoaeriee', 'ohheycreeper', 'karmalv6',
  'nachoesx', 'asdon505', 'itzoreo', 'ikzslayerpvp', 'xkqizn', 'rabbidfly',
  'aggrio', 'sabrixna9', 'pvkcc', 'qlucas xa', 'karmaiv', 'echoshardss',
  'venuequine', 'twilightzqne', 'bosscailou', 'notkeru', 'slilval',
  'chrissel2208', 'riiiinak', 'gsp theperuv', 'ineptsky', 'silverstream',
  'oman blue', 'vavze', 'talib', 'shy', 'timy', 'get owned5091', 'fly4what',
  'estboy', 'india sosweet', 'delusionaltoad', 'saduqkeet', 'saltofficialttv',
  'iccedarticus', 'riddledlace4000'
])

function normalizeName (name) {
  return String(name || '').replace(/§./g, '').trim().toLowerCase()
}

function isStaffMod (name) {
  return STAFF_MODS.has(normalizeName(name))
}

module.exports = {
  STAFF_MODS,
  normalizeName,
  isStaffMod
}