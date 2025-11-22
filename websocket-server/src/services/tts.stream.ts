import { WebSocket } from 'ws';
import logger from '../config/logger';
import { TTSService } from './tts.service';

// Twilio 스트림 전송 옵션
export interface TwilioStreamOptions {
    streamSid: string;
    twilioConn: WebSocket;
    chunkSize?: number; // 기본: 160 bytes
    chunkIntervalMs?: number; // 기본: 20ms
}

// TTS 스트리밍 결과
export interface TTSStreamResult {
    success: boolean;
    totalChunks: number;
    totalBytes: number;
    durationMs?: number;
    error?: string;
}

export class TTSStreamer {
    private ttsService: TTSService;

    constructor(ttsService: TTSService) {
        this.ttsService = ttsService;
    }

    // 텍스트를 TTS로 변환하고 Twilio로 스트리밍
    async streamTextToTwilio(text: string, options: TwilioStreamOptions): Promise<TTSStreamResult> {
        const startTime = Date.now();

        try {
            // 1. TTS로 ulaw 오디오 생성
            const ulawAudio = await this.ttsService.synthesizeSpeechToUlaw(text);

            // 2. Twilio로 스트리밍
            const result = await this.streamAudioToTwilio(ulawAudio, options);

            return {
                ...result,
                durationMs: Date.now() - startTime,
            };
        } catch (error) {
            logger.error(`TTS 스트리밍 실패: ${error}`);
            return {
                success: false,
                totalChunks: 0,
                totalBytes: 0,
                error: String(error),
            };
        }
    }

    async streamAudioToTwilio(ulawAudio: Buffer, options: TwilioStreamOptions): Promise<TTSStreamResult> {
        const { streamSid, twilioConn, chunkSize = 160, chunkIntervalMs = 20 } = options;

        if (!this.isWebSocketOpen(twilioConn)) {
            logger.error('Twilio WebSocket이 열려있지 않습니다');
            return {
                success: false,
                totalChunks: 0,
                totalBytes: 0,
                error: 'WebSocket not open',
            };
        }

        // 청크로 분할
        const chunks = this.ttsService.splitIntoChunks(ulawAudio, chunkSize);
        logger.info(`Twilio로 스트리밍 시작: ${chunks.length} 청크, ${ulawAudio.length} bytes`);

        let sentChunks = 0;
        const startTime = Date.now();

        // 청크를 순차적으로 전송 (절대 시간 기준)
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            if (!this.isWebSocketOpen(twilioConn)) {
                logger.warn(`WebSocket이 닫혔습니다. ${sentChunks}/${chunks.length} 청크 전송됨`);
                break;
            }

            // Base64 인코딩
            const payload = chunk.toString('base64');

            // Twilio media 이벤트 전송
            const mediaEvent = {
                event: 'media',
                streamSid,
                media: {
                    payload,
                },
            };

            this.sendToTwilio(twilioConn, mediaEvent);
            sentChunks++;

            // 마크 이벤트 전송 -> Twillio 측에서 음성 발송이 끝났다는 응답을 가능하게 함
            if (sentChunks % 10 === 0) {
                // 10개 청크마다 mark
                this.sendToTwilio(twilioConn, {
                    event: 'mark',
                    streamSid,
                    mark: {
                        name: `tts_chunk_${sentChunks}`,
                    },
                });
            }

            // 청크 간격 대기 -> 20ms 간격 발송
            if (chunkIntervalMs > 0 && i < chunks.length - 1) {
                // 다음 청크의 목표 전송 시간 계산
                const targetTime = startTime + (i + 1) * chunkIntervalMs;
                const now = Date.now();
                const sleepTime = targetTime - now;

                // 목표 시간까지 남은 시간만큼 대기
                if (sleepTime > 0) {
                    await this.sleep(sleepTime);
                }
            }
        }

        logger.info(`Twilio 스트리밍 완료: ${sentChunks}/${chunks.length} 청크 전송`);

        return {
            success: sentChunks === chunks.length,
            totalChunks: sentChunks,
            totalBytes: ulawAudio.length,
        };
    }

    private sendToTwilio(ws: WebSocket, data: any): void {
        if (this.isWebSocketOpen(ws)) {
            ws.send(JSON.stringify(data));
        }
    }

    private isWebSocketOpen(ws: WebSocket): boolean {
        return ws.readyState === WebSocket.OPEN;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // 현재 재생 중인 오디오를 중단하고 버퍼 클리어
    clearTwilioStream(twilioConn: WebSocket, streamSid: string): void {
        if (this.isWebSocketOpen(twilioConn)) {
            this.sendToTwilio(twilioConn, {
                event: 'clear',
                streamSid,
            });
            logger.info(`Twilio 스트림 클리어: ${streamSid}`);
        }
    }
}

// 헬퍼 함수: 텍스트를 TTS로 변환하고 Twilio로 스트리밍
export async function sendTTSToTwilio(
    ttsService: TTSService,
    text: string,
    twilioConn: WebSocket,
    streamSid: string
): Promise<TTSStreamResult> {
    const streamer = new TTSStreamer(ttsService);

    return streamer.streamTextToTwilio(text, {
        streamSid,
        twilioConn,
    });
}

export default TTSStreamer;
