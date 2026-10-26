// Checks the color tokens in public/style.css against WCAG 2.2 AA contrast, in both themes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');

function tokensIn(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

const blockAfter = (marker) => {
  const start = css.indexOf('{', css.indexOf(marker)) + 1;
  return css.slice(start, css.indexOf('}', start));
};

const light = tokensIn(blockAfter(':root {'));
const darkFromSystem = tokensIn(blockAfter(":root:not([data-theme='light'])"));
const darkForced = tokensIn(blockAfter(":root[data-theme='dark']"));

// WCAG 2.x relative luminance and contrast ratio.
const luminance = (hex) => {
  const [r, g, b] = hex
    .match(/[0-9a-f]{2}/gi)
    .map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT = 4.5; // 1.4.3 normal text
const NON_TEXT = 3; // 1.4.11 UI components and graphics

// [foreground, background, minimum, where it's used]
const PAIRS = [
  ['fg', 'bg', TEXT, 'body text'],
  ['fg', 'hover', TEXT, 'text on hovered rows'],
  ['fg', 'badge-bg', TEXT, 'state badges'],
  ['muted', 'bg', TEXT, 'secondary text'],
  ['muted', 'hover', TEXT, 'secondary text on hovered rows'],
  ['muted', 'badge-bg', TEXT, 'tags'],
  ['red', 'bg', TEXT, 'needs-attention heading, changes-requested reviewers, errors'],
  ['red', 'hover', TEXT, 'red text on hovered rows'],
  ['yellow', 'bg', TEXT, 'commented reviewers'],
  ['yellow', 'hover', TEXT, 'commented reviewers on hovered rows'],
  ['green', 'bg', TEXT, 'approved reviewers, additions'],
  ['green', 'hover', TEXT, 'approved reviewers on hovered rows'],
  ['blue', 'bg', TEXT, 'links'],
  ['blue', 'hover', TEXT, 'links on hovered rows'],
  ['on-solid', 'red-solid', TEXT, '"waiting on you" chips'],
  ['on-solid', 'yellow-solid', TEXT, '"changed since you viewed" chips'],
  ['on-solid', 'green-solid', TEXT, 'primary button'],
  ['bg', 'fg', TEXT, 'selected segmented button'],
  ['control-border', 'bg', NON_TEXT, 'input, select and checkbox borders'],
  ['gray', 'bg', NON_TEXT, 'dismissed-PR dots'],
  ['focus', 'bg', NON_TEXT, 'focus ring'],
];

describe('theme tokens', () => {
  it('keeps the two dark blocks identical', () => {
    expect(darkForced).toEqual(darkFromSystem);
  });

  it('defines the same tokens in light and dark', () => {
    expect(Object.keys(darkForced).sort()).toEqual(Object.keys(light).sort());
  });
});

for (const [name, theme] of [
  ['light', light],
  ['dark', darkForced],
]) {
  describe(`${name} theme contrast (WCAG 2.2 AA)`, () => {
    for (const [fg, bg, min, use] of PAIRS) {
      it(`${fg} on ${bg} ≥ ${min}:1 (${use})`, () => {
        expect(theme[fg], `missing --${fg}`).toBeDefined();
        expect(theme[bg], `missing --${bg}`).toBeDefined();
        expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(min);
      });
    }
  });
}
