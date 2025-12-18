import { WebSocket } from 'ws';

/**
 * OpenAI TTS API 설정
 */
export interface TTSConfig {
    model?: 'tts-1' | 'tts-1-hd';
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
    speed?: number; // 0.25 ~ 4.0
}

/**
 * Twilio 스트림 전송 옵션
 */
export interface TwilioStreamOptions {
    streamSid: string;
    twilioConn: WebSocket;
    chunkSize?: number; // 기본: 160 bytes
    chunkIntervalMs?: number; // 기본: 20ms
}

/**
 * TTS 스트리밍 결과
 */
export interface TTSStreamResult {
    success: boolean;
    totalChunks: number;
    totalBytes: number;
    durationMs?: number;
    firstChunkTimestamp?: number;
    error?: string;
}
