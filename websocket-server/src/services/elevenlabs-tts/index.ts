import { ElevenLabsService } from './elevenlabs.service';
import { defaultConfig } from './elevenlabs.config';

// ElevenLabs TTS 서비스 싱글톤 인스턴스
export const elevenLabsService = new ElevenLabsService(defaultConfig);

// 타입 및 클래스 re-export
export { ElevenLabsService } from './elevenlabs.service';
export type { ElevenLabsConfig } from './elevenlabs.config';
export type { ElevenLabsSession, ElevenLabsStreamResult } from './elevenlabs.types';
