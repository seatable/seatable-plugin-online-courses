import React from 'react';
import intl from 'react-intl-universal';

/**
 * A string of the plugin's interface, in the language SeaTable is displayed in — English
 * when that language does not have it (`fallbackLocale` in entry.tsx).
 *
 * `{name}` is filled from `vars` here rather than by intl.get: intl.get escapes `<` and
 * `>` in the values it inserts, which React would then show as `&lt;`, and it reads a
 * straight apostrophe next to a brace as an ICU escape. Everything shown through t() is
 * plain text, set as a text node, so nothing needs escaping.
 *
 * Call it at render time, never at module load: the locale is initialised in entry.tsx,
 * after the modules have been evaluated.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const message = intl.get(key) || key;
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole
  );
}

/**
 * The same, for a sentence with React nodes in it — a highlighted base name, a link:
 * each `{name}` is replaced by `parts[name]`, the rest stays text. Use it inside JSX,
 * e.g. `<>{tNodes('key', { base: <span style={…}>{name}</span> })}</>`.
 */
export function tNodes(key: string, parts: Record<string, React.ReactNode>): React.ReactNode[] {
  const message = intl.get(key) || key;
  return message.split(/(\{\w+\})/).map((piece, i) => {
    const match = piece.match(/^\{(\w+)\}$/);
    const node = match && match[1] in parts ? parts[match[1]] : piece;
    return React.createElement(React.Fragment, { key: i }, node);
  });
}
