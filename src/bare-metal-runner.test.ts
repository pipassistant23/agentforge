import { describe, it, expect } from 'vitest';

import { parseOutputChunks, AgentOutput } from './bare-metal-runner.js';

// Sentinel markers (must match the constants in bare-metal-runner.ts)
const START = '---AGENTFORGE_OUTPUT_START---';
const END = '---AGENTFORGE_OUTPUT_END---';

function wrap(obj: object): string {
  return `${START}${JSON.stringify(obj)}${END}`;
}

// --- parseOutputChunks ---

describe('parseOutputChunks', () => {
  // --- Normal single message ---

  it('parses a single complete message in one chunk', () => {
    const payload: AgentOutput = {
      status: 'success',
      result: 'Hello world',
    };
    const chunk = wrap(payload);

    const { buffer, messages } = parseOutputChunks('', chunk);

    expect(messages).toHaveLength(1);
    expect(messages[0].parsed).toEqual(payload);
    expect(buffer).toBe('');
  });

  it('includes the raw JSON string in the returned message', () => {
    const payload: AgentOutput = { status: 'success', result: 'test' };
    const { messages } = parseOutputChunks('', wrap(payload));

    expect(messages[0].raw).toBe(JSON.stringify(payload));
  });

  // --- Message split across multiple chunks (partial chunk handling) ---

  it('accumulates a partial message and completes it in the next chunk', () => {
    const payload: AgentOutput = { status: 'success', result: 'split' };
    const full = wrap(payload);

    // Split the full string at an arbitrary mid-point
    const mid = Math.floor(full.length / 2);
    const chunk1 = full.slice(0, mid);
    const chunk2 = full.slice(mid);

    // First chunk — no complete pair yet
    const step1 = parseOutputChunks('', chunk1);
    expect(step1.messages).toHaveLength(0);
    expect(step1.buffer).toBe(chunk1);

    // Second chunk completes the pair
    const step2 = parseOutputChunks(step1.buffer, chunk2);
    expect(step2.messages).toHaveLength(1);
    expect(step2.messages[0].parsed).toEqual(payload);
    expect(step2.buffer).toBe('');
  });

  it('handles a START marker split across two chunks', () => {
    const payload: AgentOutput = { status: 'success', result: 'split-start' };
    const full = wrap(payload);

    // Split inside the START marker itself
    const splitPoint = 5; // mid-way through "---AGENTFORGE_OUTPUT_START---"
    const chunk1 = full.slice(0, splitPoint);
    const chunk2 = full.slice(splitPoint);

    const step1 = parseOutputChunks('', chunk1);
    expect(step1.messages).toHaveLength(0);

    const step2 = parseOutputChunks(step1.buffer, chunk2);
    expect(step2.messages).toHaveLength(1);
    expect(step2.messages[0].parsed).toEqual(payload);
  });

  // --- Multiple back-to-back markers in one chunk ---

  it('extracts multiple messages from a single chunk', () => {
    const p1: AgentOutput = { status: 'success', result: 'first' };
    const p2: AgentOutput = { status: 'success', result: 'second' };
    const p3: AgentOutput = {
      status: 'success',
      result: null,
      newSessionId: 'sess-abc',
    };

    const chunk = wrap(p1) + wrap(p2) + wrap(p3);
    const { buffer, messages } = parseOutputChunks('', chunk);

    expect(messages).toHaveLength(3);
    expect(messages[0].parsed).toEqual(p1);
    expect(messages[1].parsed).toEqual(p2);
    expect(messages[2].parsed).toEqual(p3);
    expect(buffer).toBe('');
  });

  it('preserves trailing incomplete marker as the new buffer', () => {
    const complete: AgentOutput = { status: 'success', result: 'done' };
    const partial = START + '{"status":"success"'; // no END yet

    const chunk = wrap(complete) + partial;
    const { buffer, messages } = parseOutputChunks('', chunk);

    expect(messages).toHaveLength(1);
    expect(messages[0].parsed).toEqual(complete);
    expect(buffer).toBe(partial);
  });

  // --- Malformed / incomplete JSON between markers ---

  it('silently skips malformed JSON between markers', () => {
    const bad = `${START}not-valid-json${END}`;
    const good: AgentOutput = { status: 'success', result: 'ok' };
    const chunk = bad + wrap(good);

    const { buffer, messages } = parseOutputChunks('', chunk);

    // Bad entry is skipped; good entry is returned
    expect(messages).toHaveLength(1);
    expect(messages[0].parsed).toEqual(good);
    expect(buffer).toBe('');
  });

  it('silently skips an empty JSON body between markers', () => {
    const empty = `${START}${END}`;
    const good: AgentOutput = { status: 'error', result: null, error: 'boom' };
    const chunk = empty + wrap(good);

    const { buffer, messages } = parseOutputChunks('', chunk);

    expect(messages).toHaveLength(1);
    expect(messages[0].parsed.status).toBe('error');
  });

  // --- Empty chunk ---

  it('returns unchanged buffer and no messages for empty chunk', () => {
    const existing = `${START}partial`;
    const { buffer, messages } = parseOutputChunks(existing, '');

    expect(messages).toHaveLength(0);
    expect(buffer).toBe(existing);
  });

  it('returns empty buffer and no messages when both buffer and chunk are empty', () => {
    const { buffer, messages } = parseOutputChunks('', '');

    expect(messages).toHaveLength(0);
    expect(buffer).toBe('');
  });

  // --- Noise around markers (e.g. debug output interleaved) ---

  it('ignores noise before the START marker', () => {
    const payload: AgentOutput = { status: 'success', result: 'signal' };
    const chunk = 'some debug output\n' + wrap(payload);

    const { messages } = parseOutputChunks('', chunk);

    expect(messages).toHaveLength(1);
    expect(messages[0].parsed).toEqual(payload);
  });

  it('preserves noise after last END marker in the buffer', () => {
    const payload: AgentOutput = { status: 'success', result: 'x' };
    const noise = '\nmore debug output';
    const chunk = wrap(payload) + noise;

    const { buffer, messages } = parseOutputChunks('', chunk);

    expect(messages).toHaveLength(1);
    expect(buffer).toBe(noise);
  });

  // --- newSessionId passthrough ---

  it('preserves newSessionId in the parsed output', () => {
    const payload: AgentOutput = {
      status: 'success',
      result: null,
      newSessionId: 'new-session-123',
    };

    const { messages } = parseOutputChunks('', wrap(payload));

    expect(messages[0].parsed.newSessionId).toBe('new-session-123');
  });
});
