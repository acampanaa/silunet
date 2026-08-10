(() => {
  'use strict';

  const glyphs = {
    refresh: '<path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 11"/><path d="M3 4v7h7"/><path d="M4 13a8.1 8.1 0 0 0 14.9 4L21 13"/><path d="M14 13h7v7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    lock: '<rect width="14" height="10" x="5" y="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    network: '<rect width="6" height="6" x="9" y="2" rx="2"/><rect width="6" height="6" x="2" y="16" rx="2"/><rect width="6" height="6" x="16" y="16" rx="2"/><path d="M12 8v4M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/>',
    crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7Z"/><path d="M5 20h14"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.5 1-1 1.2C7.8 18.8 7 20.3 7 22M14 14.7V17c0 .6.5 1 1 1.2 1.2.6 2 2.1 2 3.8M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    gamepad: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><rect x="2" y="6" width="20" height="12" rx="5"/>',
    star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
    medal: '<circle cx="12" cy="8" r="6"/><path d="M15.5 12.9 17 22l-5-3-5 3 1.5-9.1"/>',
    plug: '<path d="m12 22 1-5-3-3 5-1 1-5"/><path d="m9 7 1-5M14 8l3-4M7 11 3 3M16 13l3 3"/>',
    'arrow-left': '<path d="m15 18-6-6 6-6"/>',
    'arrow-right': '<path d="m9 18 6-6-6-6"/>',
    'rotate-cw': '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    'chevrons-down': '<path d="m7 7 5 5 5-5M7 13l5 5 5-5"/>',
  };

  function safeClassName(value = '') {
    return String(value).replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  }

  function icon(name, className = '') {
    const glyph = glyphs[name];
    if (!glyph) return '';
    const classes = ['ico', safeClassName(className)].filter(Boolean).join(' ');
    return `<svg class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
  }

  function medalNum(number, className = '') {
    const numeral = Math.max(1, Math.min(9, Number(number) || 1));
    const classes = ['ico', safeClassName(className)].filter(Boolean).join(' ');
    return `<svg class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${glyphs.medal}
      <text x="12" y="8.4" text-anchor="middle" dominant-baseline="middle" stroke="none"
        fill="currentColor" font-size="8" font-weight="700"
        font-family="JetBrains Mono, monospace">${numeral}</text>
    </svg>`;
  }

  function hydrate(root = document) {
    root.querySelectorAll('[data-silunet-icon]').forEach(element => {
      element.innerHTML = icon(element.dataset.silunetIcon, element.dataset.iconClass || '');
      element.setAttribute('aria-hidden', 'true');
    });
  }

  const api = { icon, medalNum, hydrate };
  Object.keys(glyphs).forEach(name => {
    api[name] = (className = '') => icon(name, className);
  });
  window.SilunetIcons = Object.freeze(api);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hydrate(), { once: true });
  } else {
    hydrate();
  }
})();
