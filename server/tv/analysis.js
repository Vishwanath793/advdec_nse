import OpenAI from 'openai';
import { EXTRACTION_PROMPT, CONSENSUS_PROMPT, ANALYSIS_RULES } from './prompts.js';

export function extractionInput(transcripts) {
  if (transcripts.length !== 2 || transcripts.some(t => !t.text?.trim())) throw new Error('Both complete transcripts are required.');
  // Inline the entire UTF-8 text, avoiding retrieval tools that only sample file passages.
  return [{ role: 'user', content: [
    { type: 'input_text', text: EXTRACTION_PROMPT },
    ...transcripts.map(t => ({ type: 'input_text', text: `SOURCE FILE: ${t.filename}\nSHOW: ${t.show}\nVIDEO: ${t.url}\nBEGIN CAPTIONS\n${t.text}\nEND CAPTIONS` })),
  ] }];
}
export function completeText(response) {
  if (response.status !== 'completed' || !response.output_text?.trim()) {
    throw new Error(`Analysis did not complete: ${response.incomplete_details?.reason || response.status || 'empty response'}. No partial result will be treated as complete.`);
  }
  return response.output_text;
}
export async function analyzeTranscripts(transcripts, save, client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), previousExtraction = null) {
  const options = {
    model: process.env.OPENAI_MODEL || 'gpt-4.1', instructions: ANALYSIS_RULES,
    max_output_tokens: 32000, truncation: 'disabled', store: false,
  };
  const input = extractionInput(transcripts);
  let extraction = previousExtraction;
  if (!extraction) {
    const first = await client.responses.create({ ...options, input }, { timeout: 20 * 60_000 });
    extraction = completeText(first);
    await save('extraction', extraction, first.usage);
  }
  const second = await client.responses.create({ ...options, input: [
    ...input, { role: 'assistant', content: extraction }, { role: 'user', content: CONSENSUS_PROMPT },
  ] }, { timeout: 20 * 60_000 });
  const consensus = completeText(second);
  await save('consensus', consensus, second.usage);
  return { extraction, consensus };
}
