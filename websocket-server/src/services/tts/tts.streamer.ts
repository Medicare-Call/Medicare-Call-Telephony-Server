import { WebSocket } from 'ws';
import logger from '../../config/logger';
import { TTSService } from './tts.service';
import { TwilioStreamOptions, TTSStreamResult } from './tts.types';
import { AudioUtils } from '../../utils/audio.utils';

/**
 * TTS 오디오를 Twilio로 스트리밍하는 클래스
 */
export class TTSStreamer {
    private ttsService: TTSService;
    private currentAbortController?: AbortController;

    constructor(ttsService: TTSService) {
        this.ttsService = ttsService;
    }

    // 현재 진행 중인 스트리밍을 중단
    abortCurrentStream(): void {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = undefined;
            logger.info('현재 진행 중인 TTS 스트리밍을 중단했습니다');
        }
    }

    /**
     * 텍스트를 TTS로 변환하고 Twilio로 스트리밍
     * @param text 변환할 텍스트
     * @param options Twilio 스트림 옵션
     * @returns 스트리밍 결과
     */
    async streamTextToTwilio(text: string, options: TwilioStreamOptions): Promise<TTSStreamResult> {
        const startTime = Date.now();

        this.currentAbortController = new AbortController();
        const signal = this.currentAbortController.signal;

        try {
            // 1. TTS로 ulaw 오디오 생성
            const ulawAudio = await this.ttsService.synthesizeSpeechToUlaw(text);

            // 중단 확인 (streamAudioToTwilio에서도 청크 발송 시 확인하지만, 빠른 중지를 위해서 추가)
            if (signal.aborted) {
                logger.info('TTS 스트리밍이 중단되었습니다. (오디오 생성 후)');
                return {
                    success: false,
                    totalChunks: 0,
                    totalBytes: 0,
                    error: 'Aborted',
                };
            }

            // 2. Twilio로 스트리밍
            const result = await this.streamAudioToTwilio(ulawAudio, options, signal);

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
        } finally {
            // 스트리밍 완료 후 AbortController 정리
            this.currentAbortController = undefined;
        }
    }

    /**
     * 오디오 버퍼를 Twilio로 스트리밍
     * @param ulawAudio ulaw 형식 오디오 버퍼
     * @param options Twilio 스트림 옵션
     * @param signal 중단 신호
     * @returns 스트리밍 결과
     */
    async streamAudioToTwilio(
        ulawAudio: Buffer,
        options: TwilioStreamOptions,
        signal?: AbortSignal
    ): Promise<TTSStreamResult> {
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
        const chunks = AudioUtils.splitIntoChunks(ulawAudio, chunkSize);
        logger.debug(`Twilio로 스트리밍 시작: ${chunks.length} 청크, ${ulawAudio.length} bytes`);

        let sentChunks = 0;
        let firstChunkTimestamp: number | undefined;
        const startTime = Date.now();

        // 청크를 순차적으로 전송 (절대 시간 기준)
        for (let i = 0; i < chunks.length; i++) {
            // 중단 확인
            if (signal?.aborted) {
                logger.info(`TTS 스트리밍이 중단되었습니다. ${sentChunks}/${chunks.length} 청크 전송됨`);
                return {
                    success: false,
                    totalChunks: sentChunks,
                    totalBytes: sentChunks * chunkSize,
                    error: 'Aborted',
                };
            }

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

            // 레이턴시 측정을 위해 첫 청크 전송 시점 기록
            if (sentChunks === 1) {
                firstChunkTimestamp = Date.now();
            }

            // 마크 이벤트 전송 -> Twilio 측에서 음성 발송이 끝났다는 응답을 가능하게 함
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

        logger.debug(`Twilio 스트리밍 완료: ${sentChunks}/${chunks.length} 청크 전송`);

        return {
            success: sentChunks === chunks.length,
            totalChunks: sentChunks,
            totalBytes: ulawAudio.length,
            firstChunkTimestamp,
        };
    }

    /**
     * 현재 재생 중인 오디오를 중단하고 버퍼 클리어
     * @param twilioConn Twilio WebSocket 연결
     * @param streamSid 스트림 ID
     */
    clearTwilioStream(twilioConn: WebSocket, streamSid: string): void {
        if (this.isWebSocketOpen(twilioConn)) {
            this.sendToTwilio(twilioConn, {
                event: 'clear',
                streamSid,
            });
            logger.info(`Twilio 스트림 클리어: ${streamSid}`);
        }
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
}
