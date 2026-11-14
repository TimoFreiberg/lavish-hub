// Overflowing code blocks need keyboard focus so arrow keys can scroll them.
export function accessibleCodeBlocks(md) {
  for (const name of ['fence', 'code_block']) {
    const render = md.renderer.rules[name];
    if (render) md.renderer.rules[name] = (...args) => render(...args).replace(/^<pre\b/, '<pre tabindex="0" role="region" aria-label="Code block"');
  }
}
