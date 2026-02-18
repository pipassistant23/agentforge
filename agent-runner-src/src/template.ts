/**
 * Template variable substitution for .md files
 * Replaces {{VARNAME}} with environment variable values
 */

/**
 * Substitutes template variables in content.
 * Syntax: {{VARIABLE_NAME}}
 *
 * Supported variables:
 * - {{ASSISTANT_NAME}} - Bot/assistant name (from ASSISTANT_NAME env var, defaults to "Andy")
 *
 * @param content - Content with template variables
 * @returns Content with variables substituted
 */
export function substituteVariables(content: string): string {
  // Build variable map from environment
  const vars: Record<string, string> = {
    ASSISTANT_NAME: process.env.ASSISTANT_NAME || 'Andy',
  };

  // Replace all {{VARNAME}} occurrences
  // Pattern: {{ followed by word characters, followed by }}
  // No spaces allowed inside braces for strict matching
  return content.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    // Return the variable value if found, otherwise leave the pattern as-is
    return vars[varName as keyof typeof vars] ?? match;
  });
}
