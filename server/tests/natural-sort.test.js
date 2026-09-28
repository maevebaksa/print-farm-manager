// Unit tests for server/natural-sort.js (printer names like mini1..mini10).

const { compareNames, sortByName } = require('../natural-sort');

describe('natural-sort', () => {
  test('orders embedded numbers numerically, not character by character', () => {
    const rows = ['mini10', 'mini1', 'mini2', 'mini9'].map(name => ({ name }));
    expect(sortByName(rows).map(r => r.name)).toEqual(['mini1', 'mini2', 'mini9', 'mini10']);
  });

  test('is case-insensitive and tolerates null names', () => {
    expect(compareNames('MK4-2', 'mk4-10')).toBeLessThan(0);
    expect(() => sortByName([{ name: null }, { name: 'a' }])).not.toThrow();
  });

  test('sorts by a custom key', () => {
    const rows = [{ label: 'Rack 12' }, { label: 'Rack 3' }];
    expect(sortByName(rows, 'label').map(r => r.label)).toEqual(['Rack 3', 'Rack 12']);
  });
});
