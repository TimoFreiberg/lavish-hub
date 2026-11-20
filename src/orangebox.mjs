export const palette = {
  bg: '#262120', surface: '#1e1a18', raised: '#312b28', border: '#463c36', fg: '#ebe1cd', muted: '#a89a86',
  red: '#ffa596', orange: '#f3a762', yellow: '#ecc977', green: '#b8c47a', cyan: '#a8c6c6', purple: '#a6a2d4', pink: '#d9a5bf',
  'diff-add': '#a8dcc0', 'diff-del': '#f28270', 'on-accent': '#1e1a18',
};

export const themeCss = `:root { ${Object.entries(palette).map(([name, value]) => `--ob-${name}: ${value};`).join(' ')} }
[data-theme="orangebox"] { color-scheme: dark; --color-base-100: var(--ob-bg); --color-base-200: var(--ob-surface); --color-base-300: #171412; --color-base-content: var(--ob-fg); --color-primary: var(--ob-orange); --color-primary-content: var(--ob-on-accent); --color-secondary: var(--ob-cyan); --color-secondary-content: var(--ob-on-accent); --color-accent: var(--ob-pink); --color-accent-content: var(--ob-on-accent); --color-neutral: var(--ob-raised); --color-neutral-content: var(--ob-fg); --color-info: var(--ob-cyan); --color-info-content: var(--ob-on-accent); --color-success: var(--ob-green); --color-success-content: var(--ob-on-accent); --color-warning: var(--ob-yellow); --color-warning-content: var(--ob-on-accent); --color-error: var(--ob-red); --color-error-content: var(--ob-on-accent); }`;

export const diffThemeCss = `:host {
  --diffs-addition-color-override: ${palette['diff-add']};
  --diffs-deletion-color-override: ${palette['diff-del']};
  --diffs-modified-color-override: ${palette.orange};
  --diffs-bg-addition-override: color-mix(in srgb, ${palette['diff-add']} 13%, ${palette.bg});
  --diffs-bg-deletion-override: color-mix(in srgb, ${palette['diff-del']} 13%, ${palette.bg});
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, ${palette['diff-add']} 28%, ${palette.bg});
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, ${palette['diff-del']} 28%, ${palette.bg});
  --diffs-bg-addition-number-override: color-mix(in srgb, ${palette['diff-add']} 18%, ${palette.bg});
  --diffs-bg-deletion-number-override: color-mix(in srgb, ${palette['diff-del']} 18%, ${palette.bg});
  --diffs-bg-separator-override: color-mix(in srgb, ${palette.raised} 72%, ${palette.bg});
  --diffs-bg-buffer-override: color-mix(in srgb, ${palette.surface} 85%, ${palette.bg});
  --diffs-bg-hover-override: color-mix(in srgb, ${palette.raised} 55%, ${palette.bg});
  --diffs-fg-number-override: color-mix(in srgb, ${palette.muted} 72%, ${palette.bg});
}`;

export const syntaxTheme = {
  name: 'orangebox', type: 'dark', colors: { 'editor.background': palette.bg, 'editor.foreground': palette.fg },
  tokenColors: [
    { scope: ['keyword', 'storage'], settings: { foreground: palette.orange } },
    { scope: ['entity.name.function', 'support.function', 'variable.function'], settings: { foreground: palette.yellow } },
    { scope: ['string'], settings: { foreground: palette.green } },
    { scope: ['constant.numeric'], settings: { foreground: palette.pink } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'storage.type.class', 'storage.type.interface'], settings: { foreground: palette.cyan } },
    { scope: ['comment'], settings: { foreground: palette.muted, fontStyle: 'italic' } },
    { scope: ['punctuation', 'keyword.operator'], settings: { foreground: '#c9bea9' } },
    { scope: ['variable'], settings: { foreground: palette.fg } },
  ],
};
