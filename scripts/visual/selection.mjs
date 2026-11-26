import { variantId } from './fixtures.mjs';

export const selectedCaptures = {
  static: ['stack', 'tasks', 'markdown', 'html', 'conflict'].map(name => `hub-${name}`),
  integration: ['empty', 'stack', 'dirty', 'conflict', 'disconnected', 'tasks', 'markdown', 'html'].map(name => `hub-${name}`),
};

export function isSelected(source, variant, viewport, colorScheme) {
  return viewport.width === 1440 && viewport.height === 900 && colorScheme === 'dark' && selectedCaptures[source].includes(variantId(variant));
}
