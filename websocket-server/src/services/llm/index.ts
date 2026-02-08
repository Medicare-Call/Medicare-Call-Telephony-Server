import { LLMService } from './openai.service';
import { OPENAI_API_KEY } from '../../config/env';

export const llmService = new LLMService(OPENAI_API_KEY);

export { LLMService } from './openai.service';
export type { ChatMessage, LLMCallbacks } from './openai.types';
