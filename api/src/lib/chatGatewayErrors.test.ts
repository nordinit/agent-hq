import { extractGatewayErrorMessage, summarizeGatewayErrorForUi } from './chatGatewayErrors';

describe('chatGatewayErrors', () => {
  it('extracts nested provider errors from OpenClaw prompt-error payloads', () => {
    expect(extractGatewayErrorMessage({
      type: 'custom',
      customType: 'openclaw:prompt-error',
      data: {
        provider: 'openai-codex',
        error: 'LLM idle timeout (60s): no response from model',
      },
    })).toBe('LLM idle timeout (60s): no response from model');
  });

  it('summarizes nested prompt errors for the UI', () => {
    expect(summarizeGatewayErrorForUi({
      event: 'custom',
      payload: {
        customType: 'openclaw:prompt-error',
        data: {
          error: 'LLM idle timeout (60s): no response from model',
        },
      },
    })).toBe('LLM idle timeout (60s): no response from model');
  });
});
