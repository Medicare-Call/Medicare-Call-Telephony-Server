import OpenAI from 'openai';
import logger from '../config/logger';
import { OPENAI_API_KEY, TTS_MODEL, TTS_VOICE, TTS_SPEED } from '../config/env';

export interface TTSConfig {
    model?: 'tts-1' | 'tts-1-hd';
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
    speed?: number; // 0.25 ~ 4.0
}

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

    // 텍스트를 g711_ulaw 형식의 오디오로 변환
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

            // 3. 리샘플링 (24kHz -> 8kHz)
            const pcm8kBuffer = this.resamplePcm(pcm24kBuffer, 24000, 8000);
            logger.info(`리샘플링 완료: ${pcm24kBuffer.length} → ${pcm8kBuffer.length} bytes`);

            // 4. PCM -> ulaw 변환
            const ulawBuffer = this.convertPcm16ToUlaw(pcm8kBuffer);
            logger.info(`ulaw 변환 완료: ${ulawBuffer.length} bytes`);

            return ulawBuffer;
        } catch (error) {
            logger.error('TTS 합성 실패:', error);
            throw error;
        }
    }

    // N-tap Low-pass Filter 적용
    // 전체 PCM 버퍼에 대해 Anti-aliasing을 위한 Low-pass Filter 적용
    // tap 필터 탭 수는 3, 5, 7만 허용, 기본값은 3-tap
    private applyLowPassFilter(pcmBuffer: Buffer, tap: 3 | 5 | 7 = 3): Buffer {
        const samples = pcmBuffer.length / 2; // 전체 샘플 개수 = 버퍼 크기 / 2
        const filteredBuffer = Buffer.alloc(pcmBuffer.length);
        const halfTap = Math.floor(tap / 2); // 앞 뒤로 확인하는 너비 값, 3->1, 5->2, 7->3

        for (let i = 0; i < samples; i++) {
            let sum = 0;
            let count = 0;

            // N-tap 필터 -> 중심 샘플 주변의 [-halfTap, +halfTap] 범위의 평균
            for (let j = -halfTap; j <= halfTap; j++) {
                const idx = i + j;
                if (idx >= 0 && idx < samples) {
                    sum += pcmBuffer.readInt16LE(idx * 2);
                    count++;
                }
            }

            const filtered = Math.floor(sum / count);
            filteredBuffer.writeInt16LE(filtered, i * 2);
        }

        return filteredBuffer;
    }

    // Linear Interpolation을 사용하여 리샘플링 진행
    // e.g., 24000 -> 8000
    // 현재 로직에서는 사실상 Linear Interpolation이 의미없으나, 일반적인 리샘플러 패턴을 위해 구조 유지
    private interpolateBuffer(filteredBuffer: Buffer, sourceRate: number, targetRate: number): Buffer {
        const ratio = sourceRate / targetRate;
        const sourceSamples = filteredBuffer.length / 2; // 16-bit = 2 bytes per sample
        const targetSamples = Math.floor(sourceSamples / ratio);
        const targetBuffer = Buffer.alloc(targetSamples * 2);

        for (let i = 0; i < targetSamples; i++) {
            const sourcePos = i * ratio;
            const sourceIndex = Math.floor(sourcePos);
            const fraction = sourcePos - sourceIndex;

            if (sourceIndex + 1 < sourceSamples) {
                // Linear Interpolation: 두 샘플 사이를 선형 보간
                const sample1 = filteredBuffer.readInt16LE(sourceIndex * 2);
                const sample2 = filteredBuffer.readInt16LE((sourceIndex + 1) * 2);
                const interpolated = Math.round(sample1 + (sample2 - sample1) * fraction);
                targetBuffer.writeInt16LE(interpolated, i * 2);
            } else {
                // 마지막 샘플, 보간 불필요
                const sample = filteredBuffer.readInt16LE(sourceIndex * 2);
                targetBuffer.writeInt16LE(sample, i * 2);
            }
        }

        return targetBuffer;
    }

    // PCM 리샘플링 (24kHz → 8kHz)
    // Anti-aliasing Filter + Linear Interpolation 방식으로 음질 보정하여 제공
    // 여기서 filterTap에 기본값인 3 지정 (3-tap)
    private resamplePcm(pcmBuffer: Buffer, sourceRate: number, targetRate: number, filterTap: 3 | 5 | 7 = 7): Buffer {
        // 1. Low-pass Filter 적용 (안티 엘리어싱)
        const filteredBuffer = this.applyLowPassFilter(pcmBuffer, filterTap);

        // 2. Linear Interpolation 진행 (리샘플링)
        const resampledBuffer = this.interpolateBuffer(filteredBuffer, sourceRate, targetRate);

        return resampledBuffer;
    }

    // PCM16 buffer -> ulaw buffer 변환
    private convertPcm16ToUlaw(pcm16Buffer: Buffer): Buffer {
        const ulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);

        for (let i = 0; i < ulawBuffer.length; i++) {
            const pcmSample = pcm16Buffer.readInt16LE(i * 2);
            ulawBuffer[i] = this.linearToUlaw(pcmSample);
        }

        return ulawBuffer;
    }

    // PCM16 sample -> ulaw sample 변환
    private linearToUlaw(sample: number): number {
        const BIAS = 0x84;
        const CLIP = 32635;

        let sign: number;
        let exponent: number;
        let mantissa: number;
        let ulawByte: number;

        // 부호 비트 추출 및 절대값 계산
        if (sample < 0) {
            sample = -sample;
            sign = 0x80;
        } else {
            sign = 0x00;
        }

        // 클리핑
        if (sample > CLIP) {
            sample = CLIP;
        }

        // 바이어스 추가
        sample = sample + BIAS;

        // 지수 찾기
        exponent = this.findExponent(sample);

        // 가수 계산
        mantissa = (sample >> (exponent + 3)) & 0x0f;

        // ulaw 바이트 구성 및 반전
        ulawByte = ~(sign | (exponent << 4) | mantissa);

        return ulawByte & 0xff;
    }

    // 샘플의 지수 찾기
    private findExponent(sample: number): number {
        let exponent = 0;
        let testValue = 256;

        for (exponent = 0; exponent < 8; exponent++) {
            if (sample <= testValue) {
                break;
            }
            testValue <<= 1;
        }

        return exponent;
    }

    // 오디오를 청크로 분할 (Twilio 스트리밍용)
    // chunkSize 청크 크기 (기본: 160 bytes, 8kHz ulaw에서 20ms)
    // 8000 samples/sec인데, 0.02초이기에 160 samples, ulaw 기준 1 sample은 1 byte이기에, 160 bytes)
    splitIntoChunks(audioBuffer: Buffer, chunkSize: number = 160): Buffer[] {
        const chunks: Buffer[] = [];
        let offset = 0;

        while (offset < audioBuffer.length) {
            const end = Math.min(offset + chunkSize, audioBuffer.length);
            const chunk = audioBuffer.subarray(offset, end);

            // 마지막 청크가 chunkSize보다 작으면 패딩하여 160 bytes로 맞추기
            if (chunk.length < chunkSize) {
                const paddedChunk = Buffer.alloc(chunkSize, 0xff);
                chunk.copy(paddedChunk);
                chunks.push(paddedChunk);
            } else {
                chunks.push(chunk);
            }

            offset = end;
        }

        return chunks;
    }

    updateConfig(config: Partial<TTSConfig>): void {
        this.config = {
            ...this.config,
            ...config,
        };
        logger.info('TTS 설정 업데이트:', this.config);
    }

    getConfig(): Required<TTSConfig> {
        return { ...this.config };
    }
}

// 기본 TTS 서비스 인스턴스 생성 함수
// 환경 변수를 사용하여 초기화 진행 (env.ts의 상수 사용)
export function createDefaultTTSService(): TTSService {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY 환경 변수가 필요합니다.');
    }

    const config: TTSConfig = {
        model: TTS_MODEL as 'tts-1' | 'tts-1-hd',
        voice: TTS_VOICE as any, // 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
        speed: parseFloat(TTS_SPEED),
    };

    return new TTSService(OPENAI_API_KEY, config);
}

export default TTSService;
