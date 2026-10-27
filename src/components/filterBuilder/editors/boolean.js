/**
 * BOOLEAN and TRI: the same Yes/No control, keeping the value as a string.
 * `organized` is a GraphQL Boolean but the stored envelope carries
 * `'true'`/`'false'`, and `has_markers` / `is_missing` are String in the
 * schema, so field type must come from the schema, not a field list. Neither
 * has an operand, so the control renders even for a nullary modifier.
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
