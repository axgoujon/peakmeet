import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMountains } from '../src/search.js';
import { MOUNTAINS } from '../src/mountains.js';

const names = (q, n = 3) => rankMountains(MOUNTAINS, q, n).map((m) => m.name);

test('name prefixes come first', () => {
  assert.equal(names('mat')[0], 'Matterhorn');
  assert.equal(names('k')[0], 'K2');
  assert.deepEqual(names('mont b', 1), ['Mont Blanc']);
});

test('accents and case are ignored', () => {
  assert.equal(names('ecrins')[0], 'Barre des Écrins');
  assert.equal(names('MONCH')[0], 'Mönch');
  assert.equal(names('huascaran')[0], 'Huascarán');
});

test('a word inside the name and the region also match', () => {
  assert.ok(names('cook').includes('Aoraki / Mount Cook'));
  assert.ok(names('fuji').includes('Mount Fuji'));
  assert.ok(names('patagonia', 5).includes('Fitz Roy'));
});

test('an empty query lists the highest first, and nonsense lists nothing', () => {
  assert.deepEqual(names('', 2), ['Everest', 'K2']);
  assert.equal(rankMountains(MOUNTAINS, 'zzzz').length, 0);
});
