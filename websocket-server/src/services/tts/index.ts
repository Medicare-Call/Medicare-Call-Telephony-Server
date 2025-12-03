import { TTSService } from './tts.service';
import { TTSStreamer } from './tts.streamer';
import { DEFAULT_TTS_CONFIG, TTS_API_KEY } from './tts.config';

// TTS 서비스 싱글톤 인스턴스
export const ttsService = new TTSService(TTS_API_KEY, DEFAULT_TTS_CONFIG);

// TTS Streamer 싱글톤 인스턴스
export const ttsStreamer = new TTSStreamer(ttsService);

// 타입 및 클래스 re-export
export { TTSService } from './tts.service';
export { TTSStreamer } from './tts.streamer';
export type { TTSConfig, TwilioStreamOptions, TTSStreamResult } from './tts.types';
export { DEFAULT_TTS_CONFIG, TTS_API_KEY } from './tts.config';
