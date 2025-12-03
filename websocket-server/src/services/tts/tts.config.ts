import { OPENAI_API_KEY, TTS_MODEL, TTS_VOICE, TTS_SPEED } from '../../config/env';
import { TTSConfig } from './tts.types';

/**
 * 기본 TTS 설정 (OpenAI TTS API)
 */
export const DEFAULT_TTS_CONFIG: Required<TTSConfig> = {
    model: TTS_MODEL as 'tts-1' | 'tts-1-hd',
    voice: TTS_VOICE as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
    speed: parseFloat(TTS_SPEED),
};

/**
 * OpenAI API 키
 */
export const TTS_API_KEY = OPENAI_API_KEY;
