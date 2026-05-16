import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_HEADERS, CSP_HEADER } from './security-headers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEADERS_FILE = resolve(HERE, '../../../apps/web/_headers');

describe('apps/web/_headers stays in sync with the shared source of truth', () => {
  const contents = readFileSync(HEADERS_FILE, 'utf8');

  for (const [name, value] of BASE_HEADERS) {
    it(`sets ${name}`, () => {
      // The file uses a two-space indented `Name: value` form under
      // the `/*` glob. Match the trimmed line.
      expect(contents).toContain(`${name}: ${value}`);
    });
  }

  it('sets Content-Security-Policy', () => {
    expect(contents).toContain(`Content-Security-Policy: ${CSP_HEADER}`);
  });
});
