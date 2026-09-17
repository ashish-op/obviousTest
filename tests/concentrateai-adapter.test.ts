import { describe, expect, it } from 'vitest';
import {
  createConcentrateAiVisionAdapter,
  extractResponseText,
  LabelExtractionError,
  parseLabelExtractionJson,
  toLabelExtractionResult,
} from '@/lib/adapters/concentrateai';
import { jsonResponse, stubJsonFetch } from './helpers';
import errorBody from './fixtures/concentrateai/extract-label-error.json';
import outputArrayBody from './fixtures/concentrateai/extract-label-success-output-array.json';
import outputTextBody from './fixtures/concentrateai/extract-label-success-output-text.json';

describe('createConcentrateAiVisionAdapter — recorded-fixture contract tests (no live calls)', () => {
  it('parses the recorded output_text reply into a LabelExtractionResult', async () => {
    const { impl, calls } = stubJsonFetch(jsonResponse(outputTextBody, 200));
    const adapter = createConcentrateAiVisionAdapter({ apiKey: 'sk-unit-test', fetchImpl: impl });

    const label = await adapter.extractLabel('file://bottle.png');

    expect(label).toEqual({
      brandName: 'Synthroid',
      genericName: 'levothyroxine',
      dosage: '50 mcg',
      instructionsRaw:
        'Take once daily in the morning on an empty stomach, at least 1 hour before breakfast.',
      confidence: 0.93,
      highRiskSideEffects: [],
      rxcui: null,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('https://api.concentrate.ai/v1/responses');
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-unit-test');

    const sent = JSON.parse(String(calls[0].init?.body)) as { model: string; input: unknown[] };
    expect(sent.model).toBe('gpt-4o'); // default model when CONCENTRATEAI_VISION_MODEL is unset
    expect(sent.input).toHaveLength(1);
  });

  it('walks output[].content[] and strips markdown fences when output_text is absent', async () => {
    const { impl } = stubJsonFetch(jsonResponse(outputArrayBody, 200));
    const adapter = createConcentrateAiVisionAdapter({ apiKey: 'sk-unit-test', fetchImpl: impl });

    const label = await adapter.extractLabel('file://bottle.png');

    expect(label.genericName).toBe('levothyroxine');
    expect(label.confidence).toBe(0.93);
  });

  it('honors env-configurable base URL and model', async () => {
    const { impl, calls } = stubJsonFetch(jsonResponse(outputTextBody, 200));
    const adapter = createConcentrateAiVisionAdapter({
      apiKey: 'sk-unit-test',
      baseUrl: 'https://gateway.internal/api/v1/',
      model: 'llava-label-reader',
      fetchImpl: impl,
    });

    await adapter.extractLabel('file://bottle.png');

    expect(calls[0].input).toBe('https://gateway.internal/api/v1/responses');
    const sent = JSON.parse(String(calls[0].init?.body)) as { model: string };
    expect(sent.model).toBe('llava-label-reader');
  });

  it('raises LabelExtractionError with the recorded error message on a 401', async () => {
    const { impl } = stubJsonFetch(jsonResponse(errorBody, 401));
    const adapter = createConcentrateAiVisionAdapter({ apiKey: 'sk-bad', fetchImpl: impl });

    await expect(adapter.extractLabel('file://bottle.png')).rejects.toMatchObject({
      name: 'LabelExtractionError',
      status: 401,
      message: expect.stringContaining('Invalid API key provided.'),
    });
  });
});

describe('extraction parsing — strict contract, no any', () => {
  const base = {
    brandName: 'B',
    genericName: 'G',
    dosage: 'D',
    instructionsRaw: 'I',
  };

  it('clamps confidence into [0,1] and coerces rxcui to null when absent', () => {
    const high = toLabelExtractionResult({ ...base, confidence: 1.4, rxcui: undefined });
    const low = toLabelExtractionResult({ ...base, confidence: -0.2 });
    const withRxcui = toLabelExtractionResult({ ...base, confidence: 0.9, rxcui: '25762' });

    expect(high.confidence).toBe(1);
    expect(low.confidence).toBe(0);
    expect(high.rxcui).toBeNull();
    expect(withRxcui.rxcui).toBe('25762');
  });

  it('drops non-string entries from highRiskSideEffects', () => {
    const result = toLabelExtractionResult({
      ...base,
      confidence: 0.9,
      highRiskSideEffects: ['dizziness', 42, null, 'orthostasis'],
    });

    expect(result.highRiskSideEffects).toEqual(['dizziness', 'orthostasis']);
  });

  it('rejects payloads missing required fields or with non-numeric confidence', () => {
    expect(() => toLabelExtractionResult(null)).toThrow(LabelExtractionError);
    expect(() => toLabelExtractionResult({ brandName: 'B' })).toThrow(LabelExtractionError);
    expect(() => toLabelExtractionResult({ ...base, confidence: 'high' })).toThrow(
      LabelExtractionError,
    );
  });

  it('throws LabelExtractionError on prose without JSON and on malformed JSON', () => {
    expect(() => parseLabelExtractionJson('Here is your label!')).toThrow(LabelExtractionError);
    expect(() => parseLabelExtractionJson('{oops')).toThrow(LabelExtractionError);
  });

  it('returns null when a 2xx payload carries no text at all', () => {
    expect(extractResponseText('not an object')).toBeNull();
    expect(extractResponseText({})).toBeNull();
    expect(extractResponseText({ output: [] })).toBeNull();
  });
});
