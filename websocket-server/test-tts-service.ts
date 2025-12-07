import { ttsService } from './src/services/tts';
import fs from 'fs';
import path from 'path';

async function main() {
    console.log('TTS 서비스 테스트 시작\n');

    // argv 전달 문자열이 없으면 기본 텍스트
    const text = process.argv[2] || '안녕하세요 어르신, 메디케어콜 입니다.';

    console.log(`테스트 대상 텍스트: "${text}"\n`);

    try {
        // TTS 합성 (mu-law 8kHz)
        console.log('OpenAI TTS 호출 중...');
        const ulawBuffer = await ttsService.synthesizeSpeechToUlaw(text);

        console.log(`mu-law 오디오 생성 완료: ${ulawBuffer.length} bytes\n`);

        // WAV 파일로 저장
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputDir = path.join(__dirname, 'test-audio');
        const outputPath = path.join(outputDir, `tts-output-${timestamp}.wav`);

        // 디렉토리 생성
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // WAV 헤더 생성 (mu-law, 8kHz, mono)
        const wavHeader = createWavHeader(ulawBuffer.length, 8000, 1, 7); // 7 = mu-law
        const wavFile = Buffer.concat([wavHeader, ulawBuffer]);

        fs.writeFileSync(outputPath, wavFile);
        console.log(`WAV 파일 저장 완료: ${outputPath}`);
        console.log(`재생 명령: ffplay ${outputPath}`);

    } catch (error) {
        console.error('\nTTS 테스트 실패:', error);
        process.exit(1);
    }
}

// WAV 헤더 생성 함수
function createWavHeader(dataSize: number, sampleRate: number, channels: number, format: number): Buffer {
    const header = Buffer.alloc(44);

    // RIFF chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(format, 20); // audio format (7 = mu-law)
    header.writeUInt16LE(channels, 22); // mono, 좌우 구분없는 단일 스피커
    header.writeUInt32LE(sampleRate, 24); // 8000, 8kHz
    header.writeUInt32LE(sampleRate * channels, 28); // byte rate
    header.writeUInt16LE(channels, 32); // block align
    header.writeUInt16LE(8, 34); // bits per sample

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
}

main().catch(console.error);
