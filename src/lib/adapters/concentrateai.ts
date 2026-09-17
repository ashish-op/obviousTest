import { isRecord } from './json';
import type { LabelExtractionResult, VisionOcrAdapter } from './types';

/**
 * Real ConcentrateAI vision OCR (build spec: no dedicated OCR endpoint exists
 * in its docs — label extraction is a vision-capable model call through its
 * OpenAI-style unified Responses API, default base
 * https://api.concentrate.ai/v1, model name env-configurable). The factory
 * selects it only when CONCENTRATEAI_API_KEY is present.
 *
 * Only medication-label content is sent — no patient identifiers in prompts.
 */

const DEFAULT_BASE_URL = 'https://api.concentrate.ai/v1';
/** OpenAI-style default model on the gateway; override with CONCENTRATEAI_VISION_MODEL. */
const DEFAULT_VISION_MODEL = 'gpt-4o';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Extraction prompt (PRD §3 fields). The tool transcribes labels for a
 * caregiver tracking aid — it never recommends, alters, or validates a
 * prescription (scope invariant, PRD §8).
 */
const EXTRACTION_PROMPT = `Read this medication label photo and respond with ONLY a JSON object (no markdown, no prose) with exactly these keys:
{"brandName": string, "genericName": string, "dosage": string, "instructionsRaw": string, "confidence": number, "highRiskSideEffects": string[], "rxcui": string or null}
- "instructionsRaw": the dosage and administration directions exactly as printed on the label.
- "confidence": 0 to 1, how clearly you read the label.
- "highRiskSideEffects": only clinically important warning symptoms printed on the label (e.g. "dizziness", "orthostasis"); empty array when none.
- "rxcui": the RxNorm id only if it is printed on the label, otherwise null.
This is an administrative transcription for a caregiver tracking tool; do not recommend, alter, or validate any prescription.`;

export interface ConcentrateAiVisionAdapterOptions {
  apiKey: string;
  /** Env-configurable; defaults to the documented unified Responses API base. */
  baseUrl?: string;
  /** Env-configurable vision-capable model name. */
  model?: string;
  /** Injectable for contract tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class LabelExtractionError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LabelExtractionError';
    this.status = status;
  }
}

/** POST {baseUrl}/responses — JSON in, Responses-API JSON out. */
export function createConcentrateAiVisionAdapter(
  options: ConcentrateAiVisionAdapterOptions,
): VisionOcrAdapter {
  const { apiKey } = options;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async extractLabel(imageUrl: string) {
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: EXTRACTION_PROMPT },
                { type: 'input_image', image_url: imageUrl },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new LabelExtractionError(
          `ConcentrateAI extraction failed: ${describeErrorPayload(payload, response)}`,
          response.status,
        );
      }

      const text = extractResponseText(payload);
      if (text === null) {
        throw new LabelExtractionError(
          'ConcentrateAI response contained no text output',
          response.status,
        );
      }
      return parseLabelExtractionJson(text);
    },
  };
}

/**
 * Pulls the assistant text out of a Responses-API payload: prefers the
 * `output_text` convenience field, otherwise walks the `output` array for
 * message items with text content parts.
 */
export function extractResponseText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  if (typeof payload.output_text === 'string' && payload.output_text.trim().length > 0) {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) return null;
  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item)) continue;
    const content = item.content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  const joined = parts.join('');
  return joined.trim().length > 0 ? joined : null;
}

/**
 * Parses the model's text into a LabelExtractionResult. Tolerates markdown
 * fences and surrounding prose by slicing the outermost JSON object.
 */
export function parseLabelExtractionJson(text: string): LabelExtractionResult {
  const unfenced = text.replace(/```(?:json)?/g, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new LabelExtractionError('Model output contained no JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch (err: unknown) {
    const detail = isRecord(err) && typeof err.message === 'string' ? err.message : 'parse error';
    throw new LabelExtractionError(`Model output was not parseable JSON: ${detail}`);
  }

  return toLabelExtractionResult(parsed);
}

/**
 * Validates and normalizes a parsed extraction payload. Confidence is clamped
 * to [0,1]; non-string entries in highRiskSideEffects are dropped; rxcui is
 * null unless a non-empty string.
 */
export function toLabelExtractionResult(value: unknown): LabelExtractionResult {
  if (!isRecord(value)) {
    throw new LabelExtractionError('Extraction payload is not an object');
  }

  const requiredString = (key: string): string => {
    const v = value[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new LabelExtractionError(`Extraction field "${key}" must be a non-empty string`);
    }
    return v;
  };

  const rawConfidence = value.confidence;
  if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence)) {
    throw new LabelExtractionError('Extraction field "confidence" must be a finite number');
  }

  const rawSideEffects = value.highRiskSideEffects;
  const sideEffects = Array.isArray(rawSideEffects)
    ? rawSideEffects.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];

  const rawRxcui = value.rxcui;
  return {
    brandName: requiredString('brandName'),
    genericName: requiredString('genericName'),
    dosage: requiredString('dosage'),
    instructionsRaw: requiredString('instructionsRaw'),
    confidence: Math.min(1, Math.max(0, rawConfidence)),
    highRiskSideEffects: sideEffects,
    rxcui: typeof rawRxcui === 'string' && rawRxcui.trim().length > 0 ? rawRxcui : null,
  };
}

function describeErrorPayload(payload: unknown, response: Response): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
    return `${payload.error.message} (HTTP ${response.status})`;
  }
  return response.statusText || `HTTP ${response.status}`;
}
