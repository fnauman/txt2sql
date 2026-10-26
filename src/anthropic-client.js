import OpenAI from 'openai';

// Keep the existing SDK's timeout, abort and retry behavior, translating only
// the wire format to Anthropic's native Messages API. No extra SDK dependency.
export function anthropicRequest(request) {
  const { messages, ...options } = request;
  const system = messages.filter(m => m.role === 'system').map(m => ({ type: 'text', text: m.content }));
  return {
    ...options,
    model: options.model.replace(/^anthropic\//, ''),
    ...(system.length ? { system } : {}),
    messages: messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.anthropic_content ?? m.content,
    })),
  };
}

export function anthropicResponse(response) {
  const usage = response.usage || {};
  const cached = usage.cache_read_input_tokens || 0;
  const created = usage.cache_creation_input_tokens || 0;
  const prompt = (usage.input_tokens || 0) + cached + created;
  const completion = usage.output_tokens || 0;
  return {
    id: response.id,
    model: response.model,
    object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: response.stop_reason === 'max_tokens' ? 'length' : response.stop_reason === 'refusal' ? 'content_filter' : 'stop',
      message: {
        role: 'assistant',
        content: (response.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
        // Round-trip signed thinking blocks unchanged on a corrective retry.
        anthropic_content: response.content,
      },
    }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: cached, cache_creation_tokens: created },
      // Anthropic includes thinking in output_tokens but does not provide a
      // separate reasoning-token count. Do not estimate it from visible text.
    },
  };
}

export function createAnthropicClient({ apiKey, timeoutMs, maxRetries, fetch: transport = globalThis.fetch }) {
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.anthropic.com/v1',
    timeout: timeoutMs,
    maxRetries,
    fetch: async (url, init) => {
      const target = new URL(String(url));
      if (target.origin !== 'https://api.anthropic.com' || target.pathname !== '/v1/chat/completions') {
        throw new Error('Unsupported Anthropic adapter request.');
      }
      const body = anthropicRequest(JSON.parse(init.body));
      const headers = new Headers(init.headers);
      headers.delete('authorization');
      headers.delete('content-length'); // The native request has different bytes.
      headers.set('x-api-key', apiKey);
      headers.set('anthropic-version', '2023-06-01');
      const response = await transport('https://api.anthropic.com/v1/messages', {
        ...init, headers, body: JSON.stringify(body),
      });
      if (!response.ok) return response;
      const normalized = anthropicResponse(await response.json());
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('content-length');
      responseHeaders.delete('content-encoding');
      responseHeaders.set('content-type', 'application/json');
      return new Response(JSON.stringify(normalized), { status: response.status, headers: responseHeaders });
    },
  });
}
