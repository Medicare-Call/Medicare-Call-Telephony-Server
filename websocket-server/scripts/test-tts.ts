import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { Writer } from 'wav';
import { ElevenLabsService } from '../src/services/tts';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
    console.log('TTS 서비스 테스트 시작\n');

    const testText = process.argv[2] || '안녕하세요 어르신, 메디케어콜입니다. 오늘 기분은 어떠신가요?';
    console.log(`테스트 텍스트: "${testText}"\n`);

    const service = new ElevenLabsService();
    const sessionId = `test-session-${Date.now()}`;

    // Twilio로 가는 오디오를 로컬에 수집하는 mock WebSocket
    const audioChunks: Buffer[] = [];
    const mockTwilioConn = {
        readyState: WebSocket.OPEN,
        send: (data: string) => {
            const msg = JSON.parse(data);
            if (msg.event === 'media') {
                audioChunks.push(Buffer.from(msg.media.payload, 'base64'));
            }
        },
    } as unknown as WebSocket;

    console.log('ElevenLabs 연결 중...');
    const startTime = Date.now();

    try {
        await service.startSession(sessionId, mockTwilioConn, 'test-stream-sid');
        console.log(`연결 완료 (${Date.now() - startTime}ms)\n`);
    } catch (error) {
        console.error('연결 실패:', error);
        process.exit(1);
    }

    let firstChunkTime: number | null = null;

    // 완료 대기 Promise 먼저 등록
    const completionPromise = new Promise<void>((resolve) => {
        service.prepareForNewResponse(sessionId, {
            onAudioSentToTwilio: (timestamp) => {
                if (!firstChunkTime) {
                    firstChunkTime = timestamp;
                    console.log(`첫 오디오 청크 수신 (${firstChunkTime - startTime}ms)`);
                }
                process.stdout.write(`\r수신 중: ${audioChunks.length}청크, ${audioChunks.reduce((a, b) => a + b.length, 0)} bytes`);
            },
            onStreamComplete: () => {
                const totalBytes = audioChunks.reduce((a, b) => a + b.length, 0);
                const ttfb = firstChunkTime ? firstChunkTime - startTime : 0;

                console.log('\n\n' + '='.repeat(60));
                console.log('테스트 결과');
                console.log('='.repeat(60));
                console.log(`총 청크 수: ${audioChunks.length}개`);
                console.log(`총 오디오 크기: ${totalBytes} bytes`);
                console.log(`첫 청크 레이턴시: ${ttfb}ms`);
                console.log(`총 소요 시간: ${Date.now() - startTime}ms`);

                service.stopSession(sessionId);

                // WAV 파일로 저장 후 finish 이벤트에서 resolve
                if (audioChunks.length > 0) {
                    const outputDir = path.join(__dirname, 'output');
                    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

                    const outputPath = path.join(outputDir, `tts-${Date.now()}.wav`);
                    const writer = new Writer({ sampleRate: 8000, channels: 1, bitDepth: 8, format: 7 });
                    const out = fs.createWriteStream(outputPath);
                    writer.pipe(out);
                    audioChunks.forEach(chunk => writer.write(chunk));
                    writer.end();

                    out.on('finish', () => {
                        const relPath = path.relative(path.join(__dirname, '..'), outputPath);
                        console.log('\n출력 파일:');
                        console.log(`"${relPath}"`);
                        console.log('='.repeat(60));
                        resolve();
                    });
                } else {
                    resolve();
                }
            },
        });
    });

    // 실제 LLM 스트리밍 시뮬레이션: 30ms 간격으로 토큰 전송
    console.log('토큰 전송 중...');
    for (const char of testText) {
        service.sendToken(sessionId, char);
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    service.flush(sessionId);

    await completionPromise;

    process.exit(0);
}

main().catch((error) => {
    console.error('\n테스트 실패:', error);
    process.exit(1);
});
