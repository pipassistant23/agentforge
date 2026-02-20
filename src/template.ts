/**
 * Template variable substitution.
 *
 * Replaces `{{VARIABLE_NAME}}` tokens in a template string with values
 * from a provided record. Unknown tokens are left in place so callers
 * can distinguish between "not yet resolved" and "intentionally empty".
 */

/**
 * Replace `{{KEY}}` tokens in `template` with corresponding values from `vars`.
 *
 * - Tokens with a matching key are replaced with the associated string value.
 * - Tokens with no matching key are left unchanged (not blanked).
 * - Replacement is not recursive: values injected in one pass are not
 *   re-scanned for further tokens, preventing double-substitution.
 *
 * @param template - Input string potentially containing `{{KEY}}` tokens
 * @param vars     - Map from token name to replacement value
 * @returns String with all known tokens replaced
 */
export function substituteVariables(
  template: string,
  vars: Record<string, string>,
): string {
  // Replace each {{TOKEN}} with its value if found in vars.
  // Uses a single-pass replace to avoid double-substitution.
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : _match;
  });
}
