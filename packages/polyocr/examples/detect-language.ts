/**
 * Example: run language detection standalone (without OCR).
 *
 * Run with:
 *   npx tsx examples/detect-language.ts "Bonjour, comment ça va ?"
 *   npx tsx examples/detect-language.ts "123.45"   # numerals → null
 *   npx tsx examples/detect-language.ts "Hi"       # short → LLM fallback
 *
 * What it demonstrates:
 *   - The two-tier detection cascade (franc first, Ollama fallback).
 *   - The numerals-only special case that returns `language: null`.
 *   - The `source` field showing which tier produced the answer.
 */

import { detectLanguage } from '../src/index.js';

const text = process.argv.slice(2).join(' ');
if (!text) {
  console.error('Usage: npx tsx examples/detect-language.ts "<text>"');
  process.exit(1);
}

const result = await detectLanguage(text, {
  ollamaUrl: 'http://localhost:11434'
});

console.log('Input:    ', text);
console.log('Language: ', result.language ?? '(null — numerals or empty)');
console.log('Confidence:', result.confidence.toFixed(3));
console.log('Script:   ', result.script ?? '(unknown)');
console.log('Source:   ', result.source, '   ← which tier answered');
