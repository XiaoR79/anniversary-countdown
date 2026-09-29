/* 集成测试：用 jsdom 真实加载 index.html，驱动点击/提交，检查渲染与持久化 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const KEY = 'anniversary-countdown.v1';
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
const pad2 = n => (n < 10 ? '0' : '') + n;
const ymd = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
function shift(days) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return ymd(d); }

const errors = [];
async function boot(seed) {
  const dom = new JSDOM(html, {
    url: 'https://example.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.addEventListener('error', e => errors.push(String(e.error || e.message)));
      if (seed != null) window.localStorage.setItem(KEY, seed);
    }
  });
  await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
  await new Promise(r => setTimeout(r, 40));
  return dom;
}
function doc(dom) { return dom.window.document; }
function store(dom) {
  const raw = dom.window.localStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}
function items(dom) { return [...doc(dom).querySelectorAll('.item')]; }
function names(dom) { return items(dom).map(n => n.querySelector('.item-name').textContent); }
function minis(dom) { return items(dom).map(n => n.querySelector('.item-left').textContent); }
function click(dom, node) { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); }
function submit(dom) { doc(dom).getElementById('addForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }
function fill(dom, id, value) { doc(dom).getElementById(id).value = value; }
function txt(dom, id) { return doc(dom).getElementById(id).textContent; }

(async function run() {
  /* ── 1. 默认状态 ─────────────────────────────────────── */
  let dom = await boot(null);
  let s = store(dom);
  eq('默认只有 1 个纪念日', items(dom).length, 1);
  eq('默认名称', txt(dom, 'heroName'), '2027 年元旦');
  eq('默认日期显示', txt(dom, 'heroDate'), '2027 年 1 月 1 日 · 星期五 · 每年'.replace(' · 每年', ''));
  eq('默认列表日期', items(dom)[0].querySelector('.item-date').textContent.slice(0, 10), '2027.01.01');
  eq('默认写入 localStorage', s && s.items && s.items.length, 1);
  eq('默认存的是 2027-01-01', s.items[0].date, '2027-01-01');
  eq('默认不重复', s.items[0].repeat, false);
  const daysLeft = Number(txt(dom, 'uD'));
  check('主倒计时天数为正数', Number.isFinite(daysLeft) && daysLeft > 0 && daysLeft < 40000, daysLeft);
  check('小时补零为两位', /^\d\d$/.test(txt(dom, 'uH')), txt(dom, 'uH'));
  check('进度条已渲染', /%\s*$/.test(txt(dom, 'heroPct')), txt(dom, 'heroPct'));
  check('今日日期行已渲染', /\d{4}-\d\d-\d\d 星期/.test(txt(dom, 'today')), txt(dom, 'today'));
  dom.window.close();

  /* ── 2. 通过表单新增（含每年重复） ─────────────────── */
  dom = await boot(null);
  fill(dom, 'fName', '我的生日');
  fill(dom, 'fDate', '1995-06-18');
  doc(dom).getElementById('fRepeat').checked = true;
  submit(dom);
  eq('新增后列表 2 条', items(dom).length, 2);
  eq('新项成为主倒计时', txt(dom, 'heroName'), '我的生日');
  check('新项显示每年标签', items(dom).some(n => n.querySelector('.tag') && n.querySelector('.item-name').textContent === '我的生日'));
  eq('表单已清空名称', doc(dom).getElementById('fName').value, '');
  eq('重复勾选已复位', doc(dom).getElementById('fRepeat').checked, false);
  s = store(dom);
  eq('持久化条数 2', s.items.length, 2);
  eq('持久化 activeId = 新项', s.activeId, s.items[1].id);
  eq('持久化 repeat=true', s.items[1].repeat, true);
  eq('错误提示已隐藏', doc(dom).getElementById('formErr').hidden, true);

  /* ── 3. 重复添加拦截 ─────────────────────────────── */
  fill(dom, 'fName', '我的生日');
  fill(dom, 'fDate', '1995-06-18');
  doc(dom).getElementById('fRepeat').checked = true;
  submit(dom);
  eq('重复项未写入', items(dom).length, 2);
  check('提示已存在', /已经在列表里了/.test(txt(dom, 'toast')), txt(dom, 'toast'));

  /* ── 4. 校验 ────────────────────────────────────── */
  fill(dom, 'fName', '   ');
  fill(dom, 'fDate', '2030-05-05');
  submit(dom);
  eq('空名称被拦截', items(dom).length, 2);
  check('提示填名称', /起个名字/.test(txt(dom, 'formErr')), txt(dom, 'formErr'));
  fill(dom, 'fName', '测试');
  fill(dom, 'fDate', '');
  submit(dom);
  eq('空日期被拦截', items(dom).length, 2);
  check('提示选日期', /日期/.test(txt(dom, 'formErr')), txt(dom, 'formErr'));

  /* ── 5. 删除 + 撤销 ─────────────────────────────── */
  const before = names(dom);
  const delBtn = items(dom)[0].querySelector('.item-del');
  click(dom, delBtn);
  eq('删除后剩 1 条', items(dom).length, 1);
  check('提示可撤销', /撤销/.test(txt(dom, 'toast')), txt(dom, 'toast'));
  eq('删除后持久化同步', store(dom).items.length, 1);
  const undoBtn = doc(dom).querySelector('.toast-action');
  check('撤销按钮存在', !!undoBtn);
  click(dom, undoBtn);
  eq('撤销后恢复 2 条', items(dom).length, 2);
  eq('撤销后顺序不变', names(dom).join('|'), before.join('|'));
  eq('撤销后持久化同步', store(dom).items.length, 2);

  /* ── 6. 排序：今天 → 未来 → 过去 ────────────────── */
  const todaySeed = (() => { const d = new Date(); return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); })();
  const seedData = {
    v: 1,
    activeId: null,
    items: [
      { id: 'past', name: '过去的日子', date: shift(-100), color: 'amber', repeat: false },
      { id: 'today', name: '今天纪念日', date: '2000-' + todaySeed, color: 'mint', repeat: true },
      { id: 'future', name: '未来的日子', date: shift(40), color: 'cyan', repeat: false }
    ]
  };
  dom.window.close();
  dom = await boot(JSON.stringify(seedData));
  eq('排序：今天在最前', names(dom)[0], '今天纪念日');
  eq('排序：未来居中', names(dom)[1], '未来的日子');
  eq('排序：过去在最后', names(dom)[2], '过去的日子');
  eq('每年重复：今天就是那天', minis(dom)[0], '就是今天');
  eq('过去项天数正确', minis(dom)[2], '已过去 100 天');
  eq('默认主倒计时取最近的一个', txt(dom, 'heroBadge'), '就是今天');
  check('今天项主卡文案', txt(dom, 'heroNote').startsWith('今天就是这一天，已经过去'), txt(dom, 'heroNote'));
  eq('今天项秒数计数向上', Number(txt(dom, 'uD')), 0);

  click(dom, items(dom)[2]);
  eq('切到过去项：徽标', txt(dom, 'heroBadge'), '已经过去');
  eq('切到过去项：文案', txt(dom, 'heroNote').startsWith('已经过去 100 天'), true, txt(dom, 'heroNote'));
  eq('切到过去项：名称', txt(dom, 'heroName'), '过去的日子');
  eq('过去项列表与主卡天数一致', minis(dom)[2], '已过去 ' + txt(dom, 'uD') + ' 天');
  check('aria-current 跟随选中', items(dom)[2].getAttribute('aria-current') === 'true' && !items(dom)[0].hasAttribute('aria-current'));
  eq('activeId 已持久化', store(dom).activeId, 'past');

  click(dom, items(dom)[1]);
  eq('切到未来项：徽标', txt(dom, 'heroBadge'), '倒计时中');
  eq('未来项文案与盒子口径一致', txt(dom, 'heroNote'), '还有 ' + txt(dom, 'uD') + ' 天 ' + String(Number(txt(dom, 'uH'))) + ' 小时');
  eq('未来项列表与主卡天数一致', minis(dom)[1], '还有 ' + txt(dom, 'uD') + ' 天');
  dom.window.close();

  /* ── 7. 关掉重开：数据还在 ──────────────────────── */
  dom = await boot(JSON.stringify(seedData));
  const persisted = JSON.stringify(store(dom));
  dom.window.close();
  dom = await boot(persisted);
  eq('重开后条数不变', items(dom).length, 3);
  eq('重开后名称与顺序不变', names(dom).join('|'), '今天纪念日|未来的日子|过去的日子');
  eq('重开后主题色跟随激活项', doc(dom).documentElement.style.getPropertyValue('--accent').length > 0, true);
  click(dom, items(dom)[2]);
  const reopened = JSON.stringify(store(dom));
  dom.window.close();
  dom = await boot(reopened);
  eq('重开后记住上次选中的纪念日', txt(dom, 'heroName'), '过去的日子');

  /* ── 8. 全部删光：空状态且不会重新塞回默认 ───────── */
  while (items(dom).length) click(dom, items(dom)[0].querySelector('.item-del'));
  eq('全部删除后列表为空', items(dom).length, 0);
  check('显示空状态', /还没有纪念日/.test(doc(dom).querySelector('.list').textContent));
  eq('计数为 0', txt(dom, 'count'), '0');
  eq('主卡占位', txt(dom, 'heroBadge'), '还没有纪念日');
  eq('持久化为空数组', store(dom).items.length, 0);
  const emptyStored = JSON.stringify(store(dom));
  dom.window.close();
  dom = await boot(emptyStored);
  eq('重开后仍是空列表（不复活默认项）', items(dom).length, 0);
  dom.window.close();

  /* ── 9. 坏数据自愈 ─────────────────────────────── */
  dom = await boot('{ this is not json');
  eq('坏 JSON 回退到默认项', items(dom).length, 1);
  eq('坏 JSON 已备份', typeof dom.window.localStorage.getItem(KEY + '.broken'), 'string');
  dom.window.close();

  dom = await boot(JSON.stringify({ v: 1, items: [{ name: '缺日期' }, { name: '正常', date: '2030-03-03' }] }));
  eq('非法条目被丢弃，合法条目保留', items(dom).length, 1);
  eq('保留的是合法条目', names(dom)[0], '正常');
  dom.window.close();

  /* ── 10. XSS 防护：名称按文本渲染 ───────────────── */
  dom = await boot(JSON.stringify({ v: 1, items: [{ id: 'x', name: '<img src=x onerror=alert(1)>', date: '2030-01-01', color: 'rose', repeat: false }] }));
  eq('名称未被解析成 HTML', doc(dom).querySelectorAll('img').length, 0);
  eq('名称原样显示', names(dom)[0], '<img src=x onerror=alert(1)>');
  dom.window.close();

  check('运行期无未捕获错误', errors.length === 0, errors.join(' ; '));

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
