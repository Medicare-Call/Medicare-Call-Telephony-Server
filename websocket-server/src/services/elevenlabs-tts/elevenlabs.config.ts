import { ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID } from '../../config/env';

export interface ElevenLabsConfig {
    apiKey: string;
    voiceId: string;
    modelId: string;
    outputFormat: 'ulaw_8000';
    stability?: number;
    similarityBoost?: number;
    speed?: number;
}

export const defaultConfig: ElevenLabsConfig = {
    apiKey: ELEVENLABS_API_KEY,
    voiceId: ELEVENLABS_VOICE_ID,
    modelId: ELEVENLABS_MODEL_ID,
    outputFormat: 'ulaw_8000',
    stability: 0.75, // 일관된 톤을 위해 높게 설정함
    similarityBoost: 0.75,
    speed: 0.9, // 0.7~1.2, 1은 발화 속도가 빠른 편
};

export function buildWebSocketUrl(config: ElevenLabsConfig): string {
    const params = new URLSearchParams({
        model_id: config.modelId,
        output_format: config.outputFormat,
    });
    return `wss://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/stream-input?${params}`;
}
