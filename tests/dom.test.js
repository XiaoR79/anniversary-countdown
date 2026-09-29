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
  eq('默认日期显示', txt(dom, 'heroDate'), '2027 年 1 月 1 日 00:00 · 星期五');
  eq('默认列表日期', items(dom)[0].querySelector('.item-date span').textContent, '2027.01.01 00:00');
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
  eq('名称未被解析成 HTML', doc(dom).querySelectorAll('.item img').length, 0);
  eq('名称原样显示', names(dom)[0], '<img src=x onerror=alert(1)>');
  dom.window.close();

  /* ── 11. 日期精确到分 ───────────────────────────── */
  const WD = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const shiftDate = (days) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return d; };

  dom = await boot(null);
  fill(dom, 'fName', '上午的约会');
  fill(dom, 'fDate', shift(30));
  fill(dom, 'fTime', '09:30');
  submit(dom);
  const d30 = shiftDate(30);
  eq('主卡日期精确到分', txt(dom, 'heroDate'),
    d30.getFullYear() + ' 年 ' + (d30.getMonth() + 1) + ' 月 ' + d30.getDate() + ' 日 09:30 · ' + WD[d30.getDay()]);
  eq('列表也显示时间', items(dom)[0].querySelector('.item-date span').textContent, shift(30).replace(/-/g, '.') + ' 09:30');
  eq('新纪念日排在最前', names(dom).join('|'), '上午的约会|2027 年元旦');
  eq('时间已持久化', store(dom).items[1].time, '09:30');
  eq('提交后时间回到 00:00', doc(dom).getElementById('fTime').value, '00:00');
  check('秒数仍为两位', /^\d\d$/.test(txt(dom, 'uS')), txt(dom, 'uS'));
  dom.window.close();

  /* 旧数据没有 time 字段 → 补 00:00，不能崩 */
  dom = await boot(JSON.stringify({ v: 1, items: [{ id: 'legacy', name: '老数据', date: '2030-05-05', color: 'cyan', repeat: false }] }));
  eq('旧数据缺时间也能读', items(dom).length, 1);
  eq('旧数据时间补 00:00', items(dom)[0].querySelector('.item-date span').textContent, '2030.05.05 00:00');
  eq('旧数据时间已回写', store(dom).items[0].time, '00:00');
  dom.window.close();

  /* 同一天不同时间：先到的那一刻排在前面 */
  dom = await boot(JSON.stringify({ v: 1, items: [
    { id: 'late', name: '晚上', date: shift(10), time: '20:00', color: 'rose', repeat: false },
    { id: 'early', name: '早上', date: shift(10), time: '08:00', color: 'mint', repeat: false }
  ] }));
  eq('同一天按时间排序', names(dom).join('|'), '早上|晚上');
  eq('主倒计时取更早的那一刻', txt(dom, 'heroName'), '早上');
  dom.window.close();

  /* ── 12. 风景图 ─────────────────────────────────── */
  dom = await boot(null);
  const sceneImgEl = () => doc(dom).getElementById('sceneImg');
  const sceneOf = () => {
    const m = /picsum\.photos\/id\/(\d+)\//.exec(sceneImgEl().getAttribute('src') || '');
    return m ? m[1] : null;
  };
  eq('风景卡已展开', doc(dom).getElementById('scene').hidden, false);
  eq('风景卡标题跟随纪念日', txt(dom, 'sceneName'), '「2027 年元旦」的风景');
  check('图片地址是风景图库', /^https:\/\/picsum\.photos\/id\/\d+\/800\/500$/.test(sceneImgEl().getAttribute('src')), sceneImgEl().getAttribute('src'));
  check('srcset 含高清尺寸', /1600w/.test(sceneImgEl().getAttribute('srcset') || ''), sceneImgEl().getAttribute('srcset'));
  check('取到的是清单内的图', sceneOf() !== null, sceneOf());
  dom.window.close();

  /* 不同纪念日 → 不同风景 */
  const variety = JSON.stringify({ v: 1, items: [
    { id: 'a', name: '甲', date: '2031-01-01', time: '01:00', color: 'cyan', repeat: false },
    { id: 'b', name: '乙', date: '2032-02-02', time: '02:00', color: 'mint', repeat: false },
    { id: 'c', name: '丙', date: '2033-03-03', time: '03:00', color: 'amber', repeat: false },
    { id: 'd', name: '丁', date: '2034-04-04', time: '04:00', color: 'rose', repeat: false },
    { id: 'e', name: '戊', date: '2035-05-05', time: '05:00', color: 'azure', repeat: false }
  ] });
  dom = await boot(variety);
  const picked = [];
  for (const node of items(dom)) { click(dom, node); picked.push(sceneOf()); }
  eq('5 个纪念日都有风景', picked.filter(Boolean).length, 5);
  check('不同纪念日风景有区分', new Set(picked).size >= 3, picked.join(','));
  eq('风景卡标题跟着切换', txt(dom, 'sceneName'), '「戊」的风景');

  /* 换一张：换图并记住 */
  const beforeSwap = sceneOf();
  click(dom, doc(dom).getElementById('sceneSwap'));
  check('换一张后图片变了', sceneOf() !== beforeSwap, beforeSwap + ' -> ' + sceneOf());
  eq('换一张已写入本地', store(dom).items.filter(x => x.id === 'e')[0].scene, 1);
  check('换一张有提示', /换了一张风景/.test(txt(dom, 'toast')), txt(dom, 'toast'));
  const afterSwap = sceneOf();
  const swapStore = JSON.stringify(store(dom));
  dom.window.close();

  dom = await boot(swapStore);
  eq('重开后延续换过的那张', sceneOf(), afterSwap);
  dom.window.close();

  /* 图源不可用 → 自动回落到手绘风景 */
  dom = await boot(JSON.stringify({ v: 1, items: [
    { id: 'p', name: '断网那天', date: '2030-01-01', time: '00:00', color: 'violet', repeat: false },
    { id: 'q', name: '另一天', date: '2031-06-06', time: '00:00', color: 'cyan', repeat: false }
  ] }));
  const imgP = doc(dom).getElementById('sceneImg');
  imgP.dispatchEvent(new dom.window.Event('error'));
  const fallbackP = imgP.getAttribute('src');
  check('回落到内嵌 SVG', /^data:image\/svg\+xml/.test(fallbackP || ''), (fallbackP || '').slice(0, 40));
  const svgText = decodeURIComponent((fallbackP || '').replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  check('SVG 是一张完整风景', /^<svg [\s\S]*<\/svg>$/.test(svgText) && /polygon/.test(svgText), svgText.slice(0, 70));
  check('回落有说明', /画出来的风景/.test(txt(dom, 'sceneCredit')), txt(dom, 'sceneCredit'));
  eq('回落时骨架屏已收起', doc(dom).getElementById('sceneMedia').className.indexOf('pending'), -1);
  check('回落后图片会显示', imgP.className.indexOf('ready') >= 0, imgP.className);
  check('回落清掉了 srcset', imgP.getAttribute('srcset') === null, String(imgP.getAttribute('srcset')));

  click(dom, items(dom)[1]);
  const imgQ = doc(dom).getElementById('sceneImg');
  imgQ.dispatchEvent(new dom.window.Event('error'));
  check('不同纪念日画出的风景不同', imgQ.getAttribute('src') !== fallbackP);
  click(dom, items(dom)[0]);
  const imgP2 = doc(dom).getElementById('sceneImg');
  imgP2.dispatchEvent(new dom.window.Event('error'));
  eq('同一纪念日画出的风景稳定', imgP2.getAttribute('src'), fallbackP);

  /* 手绘风景的天空/山色要有多样性，不能每次都同一个色 */
  const many = { v: 1, items: [] };
  for (let i = 0; i < 12; i++) {
    many.items.push({ id: 's' + i, name: '日子' + i, date: '2033-01-0' + ((i % 9) + 1), time: '0' + (i % 9) + ':00', color: 'violet', repeat: false });
  }
  dom.window.close();
  dom = await boot(JSON.stringify(many));
  const skies = new Set();
  for (const node of items(dom)) {
    click(dom, node);
    const el2 = doc(dom).getElementById('sceneImg');
    el2.dispatchEvent(new dom.window.Event('error'));
    const src = decodeURIComponent((el2.getAttribute('src') || '').replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    const m = /stop-color="(#[0-9a-f]{6})"/.exec(src);
    if (m) skies.add(m[1]);
  }
  check('手绘风景有多种天色', skies.size >= 3, [...skies].join(',') + ' 共 ' + skies.size + ' 种');

  /* 空列表：不显示风景卡 */
  while (items(dom).length) click(dom, items(dom)[0].querySelector('.item-del'));
  eq('无纪念日时不显示风景卡', doc(dom).getElementById('scene').hidden, true);
  dom.window.close();

  check('运行期无未捕获错误', errors.length === 0, errors.join(' ; '));

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
