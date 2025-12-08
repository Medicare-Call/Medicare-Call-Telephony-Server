import OpenAI from 'openai';
import logger from '../../config/logger';
import { TTSConfig } from './tts.types';
import { AudioUtils } from '../../utils/audio.utils';

/**
 * OpenAI TTS 음성 합성 서비스
 */
export class TTSService {
    private client: OpenAI;
    private config: Required<TTSConfig>;

    constructor(apiKey: string, config?: TTSConfig) {
        if (!apiKey) {
            throw new Error('OpenAI API 키가 필요합니다. OPENAI_API_KEY를 설정해주세요.');
        }

        this.client = new OpenAI({
            apiKey,
        });

        // 기본 설정 초기화
        this.config = {
            model: config?.model || 'tts-1',
            voice: config?.voice || 'alloy',
            speed: config?.speed || 1.0,
        };

        logger.info('TTS 서비스 초기화 완료 (OpenAI)', {
            model: this.config.model,
            voice: this.config.voice,
        });
    }

    /**
     * 텍스트를 g711_ulaw 형식의 오디오로 변환
     * @param text 변환할 텍스트
     * @returns ulaw 형식 오디오 버퍼
     */
    async synthesizeSpeechToUlaw(text: string): Promise<Buffer> {
        if (!text || text.trim().length === 0) {
            throw new Error('텍스트가 비어있습니다');
        }

        try {
            // 1. OpenAI TTS API 호출 (PCM 24kHz)
            const response = await this.client.audio.speech.create({
                model: this.config.model,
                voice: this.config.voice,
                input: text,
                response_format: 'pcm',
                speed: this.config.speed,
            });

            // 2. ArrayBuffer -> Buffer 변환
            const pcm24kBuffer = Buffer.from(await response.arrayBuffer());
            logger.info(`OpenAI TTS 합성 완료: ${text.substring(0, 50)}... (${pcm24kBuffer.length} bytes)`);

            // 3. PCM 24kHz -> ulaw 8kHz 변환 (리샘플링 + 형식 변환)
            const ulawBuffer = AudioUtils.convertPcmToUlaw(pcm24kBuffer, 24000, 8000);
            logger.info(`오디오 변환 완료: ${pcm24kBuffer.length} bytes -> ${ulawBuffer.length} bytes`);

            return ulawBuffer;
        } catch (error) {
            logger.error('TTS 합성 실패:', error);
            throw error;
        }
    }

    /**
     * 현재 TTS 설정 조회
     */
    getConfig(): Required<TTSConfig> {
        return { ...this.config };
    }
}
