// Looking up a strategy field by the id a rule holds. Rules come from the picker, so a missing id is a bug: it is reported with the id here instead of
// as a read of undefined further on.

/**
 * @template T
 * @param {Map<string, T>} fields
 * @param {string} id
 * @returns {T}
 */
function knownField(fields, id){
  const f = fields.get(id);
  if(!f) throw new Error('Unknown strategy field: ' + id);
  return f;
}

export { knownField };
