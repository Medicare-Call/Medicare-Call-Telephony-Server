import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID } from './src/config/env';

interface ElevenLabsOutputMessage {
    audio?: string;
    isFinal?: boolean;
    error?: string;
}

async function main() {
    console.log('ElevenLabs TTS 테스트 시작\n');

    // 환경변수 확인
    if (!ELEVENLABS_API_KEY) {
        console.error('ELEVENLABS_API_KEY 환경변수가 설정되지 않았습니다.');
        process.exit(1);
    }
    if (!ELEVENLABS_VOICE_ID) {
        console.error('ELEVENLABS_VOICE_ID 환경변수가 설정되지 않았습니다.');
        process.exit(1);
    }

    console.log('설정:');
    console.log(`  Voice ID: ${ELEVENLABS_VOICE_ID}`);
    console.log(`  Model ID: ${ELEVENLABS_MODEL_ID}`);
    console.log('');

    // 테스트할 텍스트
    const testText = process.argv[2] || '안녕하세요 어르신, 메디케어콜입니다. 오늘 기분은 어떠신가요?';
    console.log(`테스트 텍스트: "${testText}"\n`);

    // WebSocket URL 생성
    const outputFormat = 'ulaw_8000';
    const params = new URLSearchParams({
        model_id: ELEVENLABS_MODEL_ID,
        output_format: outputFormat,
    });
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?${params}`;

    console.log('WebSocket 연결 중...');

    const ws = new WebSocket(wsUrl);
    const audioChunks: Buffer[] = [];
    let firstChunkTime: number | null = null;
    let chunkCount = 0;
    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('연결 타임아웃 (10초)'));
        }, 10000);

        ws.on('open', () => {
            clearTimeout(timeout);
            console.log('WebSocket 연결 완료\n');

            // BOS 메시지 전송
            const initMessage = {
                text: ' ',
                voice_settings: {
                    stability: 0.75,
                    similarity_boost: 0.75,
                    speed: 0.9,
                },
                xi_api_key: ELEVENLABS_API_KEY,
            };
            ws.send(JSON.stringify(initMessage));
            console.log('BOS 메시지 전송 완료');

            // 텍스트 전송 (토큰 단위 시뮬레이션)
            console.log('텍스트 토큰 전송 중...');
            const tokens = testText.split('');
            tokens.forEach((token, index) => {
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ text: token }));
                        process.stdout.write(token);
                    }
                }, index * 50); // 50ms 간격으로 토큰 전송
            });

            // EOS 메시지 전송
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ text: '' }));
                    console.log('\n\nEOS 메시지 전송 완료');
                }
            }, tokens.length * 50 + 100);

            resolve();
        });

        ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });

    // 오디오 청크 수신
    ws.on('message', (data: WebSocket.Data) => {
        try {
            const response: ElevenLabsOutputMessage = JSON.parse(data.toString());

            if (response.error) {
                console.error(`에러 응답: ${response.error}`);
                return;
            }

            if (response.audio) {
                if (!firstChunkTime) {
                    firstChunkTime = Date.now();
                    console.log(`\n첫 오디오 청크 수신 (${firstChunkTime - startTime}ms)`);
                }

                const audioBuffer = Buffer.from(response.audio, 'base64');
                audioChunks.push(audioBuffer);
                chunkCount++;

                process.stdout.write(`\r청크 수신: ${chunkCount}개, 총 ${audioChunks.reduce((a, b) => a + b.length, 0)} bytes`);
            }

            if (response.isFinal) {
                console.log('\n\n스트림 완료');
            }
        } catch (error) {
            // JSON 파싱 실패 시 무시
        }
    });

    // 연결 종료 대기
    await new Promise<void>((resolve) => {
        ws.on('close', () => {
            console.log('WebSocket 연결 종료\n');
            resolve();
        });

        // 10초 후 강제 종료
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            resolve();
        }, 10000);
    });

    // 결과 저장
    if (audioChunks.length > 0) {
        const outputDir = path.join(__dirname, 'test-audio');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, `elevenlabs-test-${Date.now()}.ulaw`);
        const audioBuffer = Buffer.concat(audioChunks);
        fs.writeFileSync(outputPath, audioBuffer);

        console.log('='.repeat(60));
        console.log('테스트 결과');
        console.log('='.repeat(60));
        console.log(`총 청크 수: ${chunkCount}개`);
        console.log(`총 오디오 크기: ${audioBuffer.length} bytes`);
        console.log(`첫 청크 레이턴시: ${firstChunkTime ? firstChunkTime - startTime : 'N/A'}ms`);
        console.log(`총 소요 시간: ${Date.now() - startTime}ms`);
        console.log(`출력 파일: ${outputPath}`);
        console.log('='.repeat(60));

        // ulaw 파일 재생 시 ffplay 사용하도록 추천 (ffmpeg 설치 요함)
        console.log('\n재생 명령어:');
        console.log(`  ffplay -f mulaw -ar 8000 "${outputPath}"`);
    } else {
        console.log('오디오 청크를 수신하지 못했습니다.');
    }

    process.exit(0);
}

main().catch((error) => {
    console.error('\n테스트 실패:', error);
    process.exit(1);
});
