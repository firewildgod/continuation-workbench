import type { CSSProperties } from 'react';

export type IconName = 'work' | 'plug' | 'restore' | 'folder' | 'arrow' | 'external' | 'shield' | 'play' | 'pause' | 'save' | 'plus' | 'check' | 'close' | 'settings' | 'terminal' | 'spark' | 'refresh' | 'copy' | 'trash' | 'info' | 'desktop' | 'chevron' | 'clock' | 'chart' | 'search' | 'download' | 'wallet';

const paths: Record<IconName, string[]> = {
  work: ['M3 4h7v7H3z', 'M14 4h7v7h-7z', 'M3 15h7v6H3z', 'M14 15h7v6h-7z'],
  plug: ['M8 3v5', 'M16 3v5', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v4'],
  restore: ['M3 11a9 9 0 1 1 3 7', 'M3 4v7h7', 'M12 7v5l3 2'],
  folder: ['M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  external: ['M14 3h7v7', 'm10 14 11-11', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
  shield: ['M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z', 'm8 12 3 3 5-6'],
  play: ['m8 4 13 8-13 8z'],
  pause: ['M7 4v16', 'M17 4v16'],
  save: ['M4 3h13l4 4v14H3V3z', 'M7 3v7h10V3', 'M7 21v-7h10v7'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['m5 12 4 4L19 6'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  settings: ['M4 7h16', 'M4 17h16', 'M9 4v6', 'M16 14v6'],
  terminal: ['M3 4h18v16H3z', 'm6 8 4 4-4 4', 'M13 16h5'],
  spark: ['m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7z'],
  refresh: ['M20 7a8 8 0 0 0-14-2L3 8', 'M3 3v5h5', 'M4 17a8 8 0 0 0 14 2l3-3', 'M16 16h5v5'],
  copy: ['M9 9h12v12H9z', 'M15 9V3H3v12h6'],
  trash: ['M3 6h18', 'M8 6V3h8v3', 'M5 6l1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
  info: ['M12 8h.01', 'M12 12v5', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
  desktop: ['M3 4h18v13H3z', 'M8 21h8', 'M12 17v4'],
  chevron: ['m9 5 7 7-7 7'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M12 7v5l3 2'],
  chart: ['M4 3v18h17', 'M8 17v-5', 'M13 17V7', 'M18 17v-8'],
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14', 'm16 16 5 5'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 17v4h16v-4'],
  wallet: ['M3 6h16v15H3z', 'M3 6V3h14v3', 'M15 11h6v5h-6z', 'M17 13.5h.01'],
};

export function Icon({ name, style }: { name: IconName; style?: CSSProperties }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name].map((path, index) => <path d={path} key={index} />)}</svg>;
}
