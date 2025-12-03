export class AudioUtils {
    /**
     * PCM -> ulaw 변환 통합 메서드 (리샘플링 포함)
     * @param pcmBuffer 원본 PCM 버퍼
     * @param sourceRate 원본 샘플레이트 (기본값: 24000)
     * @param targetRate 목표 샘플레이트 (기본값: 8000)
     * @returns ulaw 형식의 버퍼
     */
    static convertPcmToUlaw(pcmBuffer: Buffer, sourceRate: number = 24000, targetRate: number = 8000): Buffer {
        // 1. 리샘플링 (sourceRate -> targetRate)
        const resampledPcm = this.resamplePcm(pcmBuffer, sourceRate, targetRate);

        // 2. PCM -> ulaw 변환
        const ulawBuffer = this.convertPcm16ToUlaw(resampledPcm);

        return ulawBuffer;
    }

    /**
     * PCM 리샘플링 (기본적으론 24kHz -> 8kHz)
     * Anti-aliasing Filter + Linear Interpolation 방식으로 음질 보정
     * @param pcmBuffer 원본 PCM 버퍼
     * @param sourceRate 원본 샘플레이트
     * @param targetRate 목표 샘플레이트
     * @param filterTap Low-pass 필터 탭 수 (3, 5, 7)
     * @returns 리샘플링된 PCM 버퍼
     */
    static resamplePcm(pcmBuffer: Buffer, sourceRate: number, targetRate: number, filterTap: 3 | 5 | 7 = 3): Buffer {
        // 1. Low-pass Filter 적용 (안티 엘리어싱)
        const filteredBuffer = this.applyLowPassFilter(pcmBuffer, filterTap);

        // 2. Linear Interpolation 진행 (리샘플링)
        const resampledBuffer = this.interpolateBuffer(filteredBuffer, sourceRate, targetRate);

        return resampledBuffer;
    }

    /**
     * N-tap Low-pass Filter 적용
     * Anti-aliasing을 위한 필터링
     * 일단 3-tap으로 진행, 음질 개선 필요 시 수정
     * @param pcmBuffer PCM 버퍼
     * @param tap 필터 탭 수 (3, 5, 7)
     * @returns 필터링된 PCM 버퍼
     */
    private static applyLowPassFilter(pcmBuffer: Buffer, tap: 3 | 5 | 7 = 3): Buffer {
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

    /**
     * Linear Interpolation을 통한 리샘플링
     * @param filteredBuffer 필터링된 PCM 버퍼
     * @param sourceRate 원본 샘플레이트
     * @param targetRate 목표 샘플레이트
     * @returns 리샘플링된 PCM 버퍼
     */
    private static interpolateBuffer(filteredBuffer: Buffer, sourceRate: number, targetRate: number): Buffer {
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

    /**
     * PCM16 buffer -> ulaw buffer 변환
     * @param pcm16Buffer PCM16 형식의 버퍼
     * @returns ulaw 형식의 버퍼
     */
    static convertPcm16ToUlaw(pcm16Buffer: Buffer): Buffer {
        const ulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);

        for (let i = 0; i < ulawBuffer.length; i++) {
            const pcmSample = pcm16Buffer.readInt16LE(i * 2);
            ulawBuffer[i] = this.linearToUlaw(pcmSample);
        }

        return ulawBuffer;
    }

    /**
     * PCM16 sample -> ulaw sample 변환
     * @param sample PCM16 샘플 값
     * @returns ulaw 샘플 값
     */
    private static linearToUlaw(sample: number): number {
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

    /**
     * ulaw 변환을 위한 지수 찾기
     * @param sample 샘플 값
     * @returns 지수 값
     */
    private static findExponent(sample: number): number {
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

    /**
     * 오디오를 청크로 분할 (Twilio 스트리밍용)
     * @param audioBuffer 원본 오디오 버퍼
     * @param chunkSize 청크 크기 (기본: 160 bytes, 8kHz ulaw에서 20ms)
     * @returns 청크 배열
     */
    static splitIntoChunks(audioBuffer: Buffer, chunkSize: number = 160): Buffer[] {
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
}

export default AudioUtils;
