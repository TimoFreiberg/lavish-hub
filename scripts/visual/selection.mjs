import { variantId } from './fixtures.mjs';

export const selectedCaptures = {
  static: ['html-document', 'markdown-document', 'diff-jj', 'task-long-edit', 'pr-configured-rendered'],
  integration: ['diff-jj', 'task-changed-on-disk-edit', 'pr-configured-edit', ...['empty', 'stack', 'dirty', 'conflict', 'disconnected', 'changes', 'tasks', 'pr', 'markdown', 'html'].map(name => `hub-${name}`)],
};

export function isSelected(source, variant, viewport, colorScheme) {
  return viewport.width === 1440 && viewport.height === 900 && colorScheme === 'dark' && selectedCaptures[source].includes(variantId(variant));
}
