import { sttService } from './src/services/stt';
import fs from 'fs';
import path from 'path';

async function main() {
    console.log('STT 서비스 테스트 시작\n');

    // 테스트할 오디오 파일 선택 (argv 없으면 기본값)
    const audioFile = process.argv[2] || 'sample.wav';
    const audioPath = path.join(__dirname, 'test-audio', audioFile);

    if (!fs.existsSync(audioPath)) {
        console.error(`오디오 파일을 찾을 수 없습니다: ${audioPath}`);
        process.exit(1);
    }

    console.log(`오디오 파일: ${audioFile}`);

    const wavBuffer = fs.readFileSync(audioPath); // WAV 파일 로드 
    const rawPCM = wavBuffer.subarray(44); // WAV 헤더인 44 bytes 제거

    console.log(`오디오 크기: ${rawPCM.length} bytes (${(rawPCM.length / 1024).toFixed(2)} KB)\n`);

    // 결과 수집
    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    let finalTranscript = '';

    // 세션 시작
    const sessionId = `test-session-${Date.now()}`;

    console.log('STT 스트리밍 시작...\n');

    await sttService.startSTT(sessionId, {
        onTranscript: (text: string, isFinal: boolean) => {
            transcripts.push({ text, isFinal });

            if (isFinal) {
                console.log(`[최종 결과] ${text}\n`);
                finalTranscript += text + ' ';
            } else {
                console.log(`[중간 단계] ${text}`);
            }
        },
        onError: (error: Error) => {
            console.error('STT 에러:', error.message);
        },
        onClose: () => {
            console.log('STT 연결 종료');
        },
    });

    // 오디오 청크 전송
    const chunkSize = 1024; // 1KB

    for (let i = 0; i < rawPCM.length; i += chunkSize) {
        const chunk = rawPCM.subarray(i, i + chunkSize);
        sttService.sendAudio(sessionId, chunk);

        const progress = ((i / rawPCM.length) * 100).toFixed(1);
        process.stdout.write(`\r전송 중... ${progress}%`);
    }

    console.log('\n오디오 전송 완료\n');

    // STT 종료
    sttService.stopSTT(sessionId);

    // 최종 결과 대기
    console.log('최종 결과 대기 중...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 결과 요약
    console.log('\n' + '='.repeat(60));
    console.log('테스트 결과 요약');
    console.log('='.repeat(60));
    console.log(`총 응답 수: ${transcripts.length}`);
    console.log(`중간 결과: ${transcripts.filter(t => !t.isFinal).length}개`);
    console.log(`최종 결과: ${transcripts.filter(t => t.isFinal).length}개`);
    console.log('\n최종 인식 텍스트:');
    console.log(`"${finalTranscript.trim()}"`);
    console.log('='.repeat(60) + '\n');

    process.exit(0);
}

main().catch((error) => {
    console.error('\n테스트 실패:', error);
    process.exit(1);
});
