/**
 * BOOLEAN and TRI.
 *
 * Both render the same Yes/No control, and both keep the chosen value as a
 * string: `organized` is a GraphQL Boolean but the stored envelope carries
 * `'true'`/`'false'`, and `has_markers` / `is_missing` are String in the
 * schema — deliberately NOT booleans, which is the pair of fields that broke
 * when this app guessed by field list. Neither editor has an operand, so the
 * control is rendered even when the modifier is nullary.
 */
const YES_NO = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

export const chainIds = (field) => [`fb-val-${field}`];

export const parts = (field, _desc, criterion) => [{
  kind: 'choice',
  id: `fb-val-${field}`,
  apply: 'criterion',
  value: String(criterion.value),
  options: YES_NO,
}];
