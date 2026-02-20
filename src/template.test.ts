import { describe, it, expect } from 'vitest';

import { substituteVariables } from './template.js';

// --- substituteVariables ---

describe('substituteVariables', () => {
  // --- Simple substitution ---

  it('replaces a single {{TOKEN}} with its value', () => {
    expect(substituteVariables('Hello, {{NAME}}!', { NAME: 'Alice' })).toBe(
      'Hello, Alice!',
    );
  });

  it('replaces a token with an empty string value', () => {
    expect(substituteVariables('prefix-{{MID}}-suffix', { MID: '' })).toBe(
      'prefix--suffix',
    );
  });

  // --- Multiple variables in one template ---

  it('replaces multiple distinct tokens', () => {
    const result = substituteVariables(
      'Dear {{TITLE}} {{LAST}}, your code is {{CODE}}.',
      { TITLE: 'Dr.', LAST: 'Strange', CODE: '42' },
    );
    expect(result).toBe('Dear Dr. Strange, your code is 42.');
  });

  it('replaces the same token when it appears more than once', () => {
    const result = substituteVariables('{{X}} and {{X}} again', { X: 'foo' });
    expect(result).toBe('foo and foo again');
  });

  // --- Unknown variable (leave token in place) ---

  it('leaves an unknown token unchanged', () => {
    const result = substituteVariables('Hello {{UNKNOWN}}', { NAME: 'Alice' });
    expect(result).toBe('Hello {{UNKNOWN}}');
  });

  it('replaces known tokens and leaves unknown tokens', () => {
    const result = substituteVariables('{{A}} {{B}} {{C}}', {
      A: 'one',
      C: 'three',
    });
    expect(result).toBe('one {{B}} three');
  });

  // --- Empty template ---

  it('returns empty string for an empty template', () => {
    expect(substituteVariables('', { NAME: 'Alice' })).toBe('');
  });

  it('returns empty string for an empty template with no vars', () => {
    expect(substituteVariables('', {})).toBe('');
  });

  // --- Template with no tokens ---

  it('returns the template unchanged when there are no tokens', () => {
    const plain = 'No tokens here, just plain text.';
    expect(substituteVariables(plain, { IGNORED: 'value' })).toBe(plain);
  });

  it('returns the template unchanged when vars is empty', () => {
    expect(substituteVariables('Hello {{NAME}}', {})).toBe('Hello {{NAME}}');
  });

  // --- Nested-looking tokens (should NOT be double-substituted) ---

  it('does not double-substitute a value that looks like a token', () => {
    // VALUE contains a token-like string; after substitution it should remain literal
    const result = substituteVariables('{{OUTER}}', {
      OUTER: '{{INNER}}',
      INNER: 'should-not-appear',
    });
    // Single-pass: OUTER is replaced with "{{INNER}}", then scanning stops.
    // The result contains a literal "{{INNER}}" — not "should-not-appear".
    expect(result).toBe('{{INNER}}');
  });

  it('handles a value containing partial braces without misparse', () => {
    const result = substituteVariables('{{KEY}}', { KEY: '{not a token}' });
    expect(result).toBe('{not a token}');
  });

  // --- Whitespace inside token names ---

  it('does not match tokens with spaces inside the braces', () => {
    // "{{ NAME }}" — the regex captures " NAME " (with spaces) as the key.
    // Since vars has key "NAME" (no spaces) it will NOT match, leaving the token.
    const result = substituteVariables('{{ NAME }}', { NAME: 'Alice' });
    // Key " NAME " !== "NAME" → no substitution; token left as-is
    expect(result).toBe('{{ NAME }}');
  });

  it('handles a template that is only a token', () => {
    expect(substituteVariables('{{ONLY}}', { ONLY: 'replaced' })).toBe(
      'replaced',
    );
  });

  // --- Multiline templates ---

  it('substitutes tokens across multiple lines', () => {
    const template = 'Line 1: {{A}}\nLine 2: {{B}}\nLine 3: {{A}}';
    const result = substituteVariables(template, { A: 'alpha', B: 'beta' });
    expect(result).toBe('Line 1: alpha\nLine 2: beta\nLine 3: alpha');
  });
});
