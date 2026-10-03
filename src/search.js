// Mountain search with suggestions. The browser's own <datalist> is unreliable
// (barely usable in iOS Safari), so the list is drawn here.

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Best matches first: name prefix, then a word in the name, then anywhere, then region. */
export function rankMountains(mountains, query, limit = 8) {
  const q = fold(query.trim());
  if (!q) return [...mountains].sort((a, b) => b.elevation - a.elevation).slice(0, limit);
  const scored = [];
  for (const m of mountains) {
    const name = fold(m.name), region = fold(m.region);
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.split(/[\s/()'-]+/).some((w) => w.startsWith(q))) score = 1;
    else if (name.includes(q)) score = 2;
    else if (region.includes(q)) score = 3;
    if (score >= 0) scored.push([score, m]);
  }
  scored.sort((a, b) => a[0] - b[0] || b[1].elevation - a[1].elevation);
  return scored.slice(0, limit).map(([, m]) => m);
}

export function attachSearch(input, { mountains, onPick, onFreeText }) {
  const list = document.createElement('ul');
  list.className = 'suggest';
  list.id = `${input.id || 'search'}-list`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.after(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('list');

  let items = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) { list.children[i].scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', list.children[i].id); }
  };
  const pick = (m) => { input.value = m.name; close(); input.blur(); onPick(m); };
  // On opening, the box still holds the current place's name, which would
  // filter the list down to itself: browse everything until the user types.
  const render = (typed = true) => {
    const query = typed ? input.value : '';
    items = rankMountains(mountains, query, query.trim() ? 8 : 12);
    list.innerHTML = items.map((m, i) =>
      `<li id="${list.id}-${i}" role="option"><b>${m.name}</b><span>${m.region}</span><em>${m.elevation} m</em></li>`).join('')
      || '<li class="none">No mountain matches. Type lat, lon to go anywhere.</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(query.trim() && items.length ? 0 : -1);
  };

  input.addEventListener('focus', () => { input.select(); render(false); });
  input.addEventListener('click', () => { if (list.hidden) render(false); });
  input.addEventListener('input', () => render(true));
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(false); highlight(Math.min(items.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
    else if (e.key === 'Escape') { close(); input.blur(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && items[active]) pick(items[active]);
      else if (input.value.trim()) { close(); input.blur(); onFreeText(input.value); }
    }
  });
  // pointerdown rather than click: it lands before the input loses focus.
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[role=option]');
    if (!li) return;
    e.preventDefault();
    pick(items[[...list.children].indexOf(li)]);
  });
}
