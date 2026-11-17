export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
