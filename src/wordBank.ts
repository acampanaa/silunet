import { WordEntry } from './types';

// Siluetas SVG — todas usan fill="currentColor" para poder cambiar color vía CSS

const MONITOR = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="12" y="12" width="136" height="93" rx="6" fill="currentColor"/>
  <rect x="66" y="103" width="28" height="26" fill="currentColor"/>
  <rect x="42" y="127" width="76" height="12" rx="5" fill="currentColor"/>
</svg>`;

const TECLADO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="52" width="144" height="62" rx="10" fill="currentColor"/>
</svg>`;

const RATON = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="80" cy="100" rx="44" ry="50" fill="currentColor"/>
  <ellipse cx="80" cy="58" rx="38" ry="30" fill="currentColor"/>
  <rect x="75" y="10" width="10" height="32" rx="5" fill="currentColor"/>
</svg>`;

const ROUTER = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="18" y="88" width="124" height="46" rx="8" fill="currentColor"/>
  <rect x="42" y="28" width="14" height="65" rx="7" fill="currentColor"/>
  <rect x="104" y="28" width="14" height="65" rx="7" fill="currentColor"/>
</svg>`;

const SERVIDOR = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="38" y="12" width="84" height="136" rx="5" fill="currentColor"/>
</svg>`;

// Forma de nube = círculos superpuestos con base plana
const NUBE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <circle cx="80"  cy="88" r="46" fill="currentColor"/>
  <circle cx="50"  cy="96" r="30" fill="currentColor"/>
  <circle cx="110" cy="96" r="30" fill="currentColor"/>
  <circle cx="63"  cy="74" r="26" fill="currentColor"/>
  <circle cx="97"  cy="74" r="26" fill="currentColor"/>
  <rect x="22" y="94" width="116" height="50" fill="currentColor"/>
</svg>`;

const TELEFONO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="46" y="8" width="68" height="144" rx="14" fill="currentColor"/>
</svg>`;

const AUDIFONOS = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path d="M 26 90 Q 26 28 80 28 Q 134 28 134 90"
        stroke="currentColor" stroke-width="18" fill="none" stroke-linecap="round"/>
  <ellipse cx="22"  cy="104" rx="20" ry="30" fill="currentColor"/>
  <ellipse cx="138" cy="104" rx="20" ry="30" fill="currentColor"/>
</svg>`;

const CAMARA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="52" width="140" height="88" rx="10" fill="currentColor"/>
  <rect x="55" y="30" width="50" height="26" rx="6" fill="currentColor"/>
  <circle cx="80" cy="96" r="32" fill="currentColor"/>
</svg>`;

// CD/Disco óptico — forma de dona usando fill-rule="evenodd"
const DISCO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" fill="currentColor"
    d="M80,8 a72,72 0 1,0 0,144 a72,72 0 1,0 0,-144 Z
       M80,64 a16,16 0 1,0 0,32 a16,16 0 1,0 0,-32 Z"/>
</svg>`;

const USB = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="46" y="60" width="68" height="88" rx="8" fill="currentColor"/>
  <rect x="28" y="14" width="104" height="50" rx="5" fill="currentColor"/>
</svg>`;

// Tarjeta SD — pentágono (rectángulo con esquina superior-derecha cortada)
const TARJETA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <polygon points="36,22 110,22 138,50 138,148 36,148" fill="currentColor"/>
</svg>`;

export const WORD_BANK: WordEntry[] = [
  { word: 'MONITOR',   category: 'Computadores',   svg: MONITOR   },
  { word: 'TECLADO',   category: 'Computadores',   svg: TECLADO   },
  { word: 'RATON',     category: 'Computadores',   svg: RATON     },
  { word: 'ROUTER',    category: 'Redes',           svg: ROUTER    },
  { word: 'SERVIDOR',  category: 'Redes',           svg: SERVIDOR  },
  { word: 'NUBE',      category: 'Redes',           svg: NUBE      },
  { word: 'TELEFONO',  category: 'Dispositivos',    svg: TELEFONO  },
  { word: 'AUDIFONOS', category: 'Dispositivos',    svg: AUDIFONOS },
  { word: 'CAMARA',    category: 'Dispositivos',    svg: CAMARA    },
  { word: 'DISCO',     category: 'Almacenamiento',  svg: DISCO     },
  { word: 'USB',       category: 'Almacenamiento',  svg: USB       },
  { word: 'TARJETA',   category: 'Almacenamiento',  svg: TARJETA   },
];

export function getRandomRounds(count: number): WordEntry[] {
  const shuffled = [...WORD_BANK].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, WORD_BANK.length));
}
