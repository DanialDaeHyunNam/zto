// ---------- reverse-sync 1단계: 라이브 콘솔 폼 읽기 ----------
// ROADMAP #4. 설문 JSON을 SSOT로 두지 않고 "진실은 라이브 화면"이라는 결정(2026-07-23 Dan)의 첫 조각.
// 페이지에서 폼 컨트롤을 긁어 구조화된 JSON으로 회수한다. 이 결과를 보고 설문 문항 매핑을 설계한다.
//
// 왜 네이티브 태그가 아니라 ARIA role 우선인가:
// Play 콘솔·ASC는 Angular/React 커스텀 컴포넌트라 <input type="radio">가 아니라
// <div role="radio">인 경우가 많다. role은 접근성 때문에 유지될 가능성이 높아 태그보다 안정적이다.

// 타입은 shared에 산다 — 정찰 결과가 preload를 거쳐 렌더러까지 가는데 main 모듈은 그 경로에 못 낀다.
export type {
  ProbedOption,
  ProbedControl,
  ProbedLink,
  FormProbe
} from '../shared/console-types'

// 접힌 메뉴를 펼친다 — 접혀 있으면 하위 링크가 DOM에 아예 없어서(Angular가 펼칠 때 렌더)
// 그냥 긁으면 1단계만 잡힌다(2026-07-29 실측: grow-overview 하위가 통째로 누락).
// 한 번 펼치면 그 안에서 또 접힌 게 드러나므로 여러 번 호출해야 한다(호출 사이에 렌더 대기).
// 링크(<a>)는 누르면 페이지를 떠나므로 제외하고, 순수 토글만 클릭한다.
export const EXPAND_JS = `(() => {
  const scope = document.querySelector('nav') || document.body;
  const targets = Array.prototype.slice.call(scope.querySelectorAll('[aria-expanded="false"]'))
    .filter((el) => !el.closest('a[href]') && el.tagName !== 'A');
  let n = 0;
  targets.forEach((el) => { try { el.click(); n++; } catch (e) {} });
  return n;
})()`

// 페이지 컨텍스트에서 실행될 스크립트. 자기완결적이어야 하고 JSON 직렬화 가능한 값을 반환한다.
export const FORM_PROBE_JS = `(() => {
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  // 라벨 찾기: aria-label → aria-labelledby → <label for> → 감싼 <label> → 형제 텍스트
  const labelOf = (el) => {
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al) return al.trim();
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
      if (parts.length) return parts.map(txt).join(' ').trim();
    }
    if (el.id) {
      const forEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forEl) return txt(forEl);
    }
    const wrap = el.closest && el.closest('label');
    if (wrap) return txt(wrap);
    // 커스텀 컴포넌트는 라벨이 자식 텍스트인 경우가 흔하다
    const own = txt(el);
    if (own && own.length < 200) return own;
    return '';
  };

  // 조상에서 섹션 제목을 모아 문항의 소속을 남긴다
  const pathOf = (el) => {
    const out = [];
    let cur = el.parentElement;
    let hops = 0;
    while (cur && hops < 12) {
      const h = cur.querySelector && cur.querySelector('h1, h2, h3, h4, [role="heading"]');
      if (h && cur.contains(el)) {
        const t = txt(h);
        if (t && t.length < 160 && !out.includes(t)) out.push(t);
      }
      cur = cur.parentElement;
      hops++;
    }
    return out.slice(0, 3).reverse().join(' › ');
  };

  // 되짚어 찾아갈 선택자 후보 — id > name > aria-label > role+텍스트
  const selectorOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const nm = el.getAttribute && el.getAttribute('name');
    if (nm) return el.tagName.toLowerCase() + '[name="' + nm + '"]';
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al) return '[aria-label="' + al.replace(/"/g, '\\\\"') + '"]';
    const role = el.getAttribute && el.getAttribute('role');
    if (role) return '[role="' + role + '"]';
    return el.tagName.toLowerCase();
  };

  const controls = [];
  const seen = new Set();
  const push = (el, kind, extra) => {
    if (seen.has(el)) return;
    seen.add(el);
    controls.push(Object.assign({
      kind: kind,
      label: labelOf(el),
      name: (el.getAttribute && (el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('data-testid'))) || '',
      value: '',
      checked: null,
      options: [],
      selector: selectorOf(el),
      path: pathOf(el)
    }, extra || {}));
  };

  // 1) radiogroup — 선택지와 현재 선택을 한 덩어리로
  document.querySelectorAll('[role="radiogroup"]').forEach((g) => {
    if (!visible(g)) return;
    const opts = [];
    g.querySelectorAll('[role="radio"]').forEach((r) => {
      seen.add(r);
      opts.push({
        label: labelOf(r),
        value: (r.getAttribute('value') || r.getAttribute('data-value') || labelOf(r) || '').slice(0, 120),
        checked: r.getAttribute('aria-checked') === 'true'
      });
    });
    const picked = opts.find((o) => o.checked);
    push(g, 'radiogroup', { options: opts, value: picked ? picked.label : '' });
  });

  // 2) 네이티브 radio (그룹 밖) — name으로 묶는다
  const nativeRadios = {};
  document.querySelectorAll('input[type="radio"]').forEach((r) => {
    if (!visible(r) || seen.has(r)) return;
    const key = r.name || r.id || 'radio';
    (nativeRadios[key] = nativeRadios[key] || []).push(r);
  });
  Object.keys(nativeRadios).forEach((key) => {
    const group = nativeRadios[key];
    const opts = group.map((r) => { seen.add(r); return { label: labelOf(r), value: r.value || '', checked: !!r.checked }; });
    const picked = opts.find((o) => o.checked);
    push(group[0], 'radiogroup', { name: key, options: opts, value: picked ? picked.label : '' });
  });

  // 3) checkbox (role 또는 네이티브)
  document.querySelectorAll('[role="checkbox"], input[type="checkbox"]').forEach((c) => {
    if (!visible(c)) return;
    const on = c.getAttribute('aria-checked') === 'true' || c.checked === true;
    push(c, 'checkbox', { checked: !!on, value: on ? 'true' : 'false' });
  });

  // 4) select
  document.querySelectorAll('select').forEach((s) => {
    if (!visible(s)) return;
    const opts = Array.prototype.map.call(s.options, (o) => ({ label: txt(o), value: o.value, checked: o.selected }));
    push(s, 'select', { options: opts, value: s.value || '' });
  });

  // 5) 텍스트 입력 (네이티브 + role=textbox/combobox)
  document.querySelectorAll('input[type="text"], input[type="email"], input:not([type]), textarea, [role="textbox"], [role="combobox"]').forEach((t) => {
    if (!visible(t) || seen.has(t)) return;
    const v = ('value' in t ? t.value : txt(t)) || '';
    push(t, t.getAttribute('role') === 'combobox' ? 'combobox' : 'textbox', { value: String(v).slice(0, 300) });
  });

  const headings = [];
  document.querySelectorAll('h1, h2, h3, [role="heading"]').forEach((h) => {
    if (!visible(h)) return;
    const t = txt(h);
    if (t && t.length < 160 && !headings.includes(t)) headings.push(t);
  });

  // 내비게이션 지도 — 같은 호스트의 링크만, 텍스트 있는 것만. 콘솔 메뉴가 개편돼도
  // 여기서 실제 경로를 읽어 찾아간다(메뉴 구조를 문서로 복제하면 개편 때마다 낡는다).
  const links = [];
  const seenHref = new Set();
  document.querySelectorAll('a[href], [role="link"][href]').forEach((a) => {
    if (!visible(a)) return;
    const href = a.href || a.getAttribute('href') || '';
    if (!href || href.startsWith('javascript:')) return;
    try { if (new URL(href, location.href).host !== location.host) return; } catch (e) { return; }
    const t = txt(a);
    if (!t || t.length > 120) return;
    const key = t + '|' + href;
    if (seenHref.has(key)) return;
    seenHref.add(key);
    links.push({ text: t, href: href });
  });

  const counts = {};
  controls.forEach((c) => { counts[c.kind] = (counts[c.kind] || 0) + 1; });

  return {
    url: location.href,
    title: document.title,
    at: new Date().toISOString(),
    headings: headings.slice(0, 60),
    links: links.slice(0, 250),
    controls: controls.slice(0, 400),
    counts: counts
  };
})()`
