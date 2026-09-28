// Natural ("human") ordering for names with embedded numbers: mini1, mini2,
// mini10, not SQLite's plain text ORDER BY (mini1, mini10, mini2, since '1' < '2'
// character by character). SQLite has no built-in natural collation, so list
// endpoints keep ORDER BY name as a stable base and re-sort in JS with this.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareNames(a, b) {
  return collator.compare(a ?? '', b ?? '');
}

// Sorts rows in place by rows[i][key] and returns them, for chaining.
function sortByName(rows, key = 'name') {
  return rows.sort((x, y) => compareNames(x[key], y[key]));
}

module.exports = { compareNames, sortByName };
