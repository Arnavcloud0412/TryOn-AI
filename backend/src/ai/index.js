import { config } from '../config.js';
import * as gemini from './gemini.js';
import * as huggingface from './huggingface.js';
import * as mock from './mock.js';

/**
 * Provider registry. A provider exposes:
 *   generate(parts, { fast, onStage, deadline, items }) -> { buffer, mime, text, model }
 *   deleteRemoteFile(cacheEntry)
 *
 * AI_PROVIDER selects the primary provider (gemini | huggingface | mock).
 * AI_FALLBACK (default "huggingface") is used automatically when the primary
 * provider reports a quota / rate-limit / auth problem.
 */
const providers = { gemini, huggingface, mock };

export const providerName = providers[config.provider] ? config.provider : 'mock';
const primary = providers[providerName];
const fallbackName = (process.env.AI_FALLBACK ?? 'huggingface').trim().toLowerCase();
const fallback = fallbackName && fallbackName !== providerName ? providers[fallbackName] : null;

export const modelName = providerName === 'gemini' ? config.gemini.model : providerName === 'huggingface' ? huggingface.model : 'mock';
export const fallbackModel = fallback ? (fallbackName === 'huggingface' ? huggingface.model : fallbackName) : null;

const FALLBACK_CODES = new Set(['AI_QUOTA', 'AI_RATE_LIMITED', 'AI_AUTH']);

export const provider = {
  async generate(parts, opts) {
    try {
      return await primary.generate(parts, opts);
    } catch (err) {
      if (!fallback || !FALLBACK_CODES.has(err.code)) throw err;
      console.warn(`[ai] ${providerName} unavailable (${err.code}) - falling back to ${fallbackName}`);
      return fallback.generate(parts, opts);
    }
  },
  async deleteRemoteFile(entry) {
    await primary.deleteRemoteFile(entry);
  },
};
