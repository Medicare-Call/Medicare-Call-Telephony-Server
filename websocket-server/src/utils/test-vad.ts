import { createWriteStream } from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { Writer } from 'wav';

/**
 * @param callSid 
 * @param audioBuffer 
 * @returns 
 * 
 * VAD 테스트용 유틸리티입니다. 
 * 환경변수를 LOCAL로 설정하고 vad-service에서 saveUtteranceForQA를 호출하여
 * 음성 패킷을 VAD에서 잘라내는 단위로 websocket-server/temp_audio/ 디렉토리에 저장합니다.
 */

export async function saveUtteranceForQA(callSid: string, audioBuffer: Buffer[]): Promise<void> {
    if (process.env.NODE_ENV !== 'local') {
        return;
    }

    const tempDir = path.join(__dirname, '..', '..', 'temp_audio');
    try {
        await fsPromises.mkdir(tempDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(tempDir, `utterance_${callSid}_${timestamp}.wav`);

        const writer = new Writer({
            sampleRate: 8000,
            channels: 1,
            bitDepth: 8,
            format: 7 // mu-law
        });
        
        const fileStream = createWriteStream(filePath);
        
        const finished = new Promise<void>((resolve, reject) => {
            fileStream.on('finish', () => resolve());
            fileStream.on('error', reject);
        });

        writer.pipe(fileStream);
        audioBuffer.forEach(chunk => writer.write(chunk));
        writer.end();

        await finished;

        console.log(`[QA] Utterance saved to ${filePath}`);
    } catch (error) {
        console.error('[QA] Error saving utterance:', error);
    }
}
