import { ElevenLabsService } from './elevenlabs.service';
import { defaultConfig } from './elevenlabs.config';

export const ttsService = new ElevenLabsService(defaultConfig);

export { ElevenLabsService } from './elevenlabs.service';
export type { ElevenLabsConfig } from './elevenlabs.config';
export type { ElevenLabsSession, ElevenLabsStreamResult } from './elevenlabs.types';
