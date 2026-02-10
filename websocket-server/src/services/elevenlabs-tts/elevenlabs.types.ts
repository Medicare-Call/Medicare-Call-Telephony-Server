import { WebSocket } from 'ws';

/**
 * ElevenLabs TTS 콜백
 */
export interface ElevenLabsCallbacks {
    onAudioSentToTwilio?: (timestamp: number) => void;  // Twilio에 오디오 전송 시
    onStreamComplete?: () => void;                      // isFinal 수신 또는 연결 종료 시
}

/**
 * ElevenLabs WebSocket 세션 (통화당 1개)
 */
export interface ElevenLabsSession {
    ws: WebSocket;
    isActive: boolean;
    isMuted: boolean;
    twilioConn: WebSocket;
    streamSid: string;
    buffer: Buffer;
    totalChunks: number;
    totalBytes: number;
    firstChunkTimestamp?: number;
    callbacks?: ElevenLabsCallbacks; 
}

/**
 * ElevenLabs로 보내는 메시지
 */
export interface ElevenLabsInputMessage {
    text: string;
    voice_settings?: {
        stability: number;
        similarity_boost: number;
        speed: number;
    };
    xi_api_key?: string;
}

/**
 * ElevenLabs에서 받는 메시지
 */
export interface ElevenLabsOutputMessage {
    audio?: string;
    isFinal?: boolean;
    normalizedAlignment?: object;
    error?: string;
}

/**
 * 스트리밍 결과
 */
export interface ElevenLabsStreamResult {
    success: boolean;
    totalChunks: number;
    totalBytes: number;
    durationMs: number;
    firstChunkTimestamp?: number;
}
