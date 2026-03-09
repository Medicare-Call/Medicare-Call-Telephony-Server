import { LLMService } from '../src/services/llm';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('OPENAI_API_KEY가 .env에 설정되지 않았습니다.');
        process.exit(1);
    }

    console.log('LLM 서비스 테스트 시작\n');

    const llmService = new LLMService(apiKey);

    const systemPrompt = process.argv[2] || '당신은 고령자를 위한 따뜻하고 친절한 한국어 AI 전화 상담원입니다.';
    const userMessage = process.argv[3] || '밤 9시 정도에 잠자리에 들었어요.';
    const history = [
        { role: 'assistant' as const, content: '안녕하세요, 어르신~ 메디케어콜입니다. 어제는 몇 시쯤 주무셨어요?' },
    ];

    console.log(`System: ${systemPrompt}`);
    console.log(`User: ${userMessage}\n`);
    const startTime = Date.now();
    let firstTokenTime: number | null = null;
    let fullResponse = '';

    try {
        await llmService.streamResponse(
            systemPrompt,
            userMessage,
            {
                onToken: (token) => {
                    if (!firstTokenTime) firstTokenTime = Date.now();
                    fullResponse += token;
                },
                onComplete: () => {
                    const elapsed = Date.now() - startTime;
                    const ttft = firstTokenTime ? firstTokenTime - startTime : 0;
                    console.log('\n' + '='.repeat(60));
                    console.log('테스트 결과');
                    console.log('='.repeat(60));
                    console.log(`첫 토큰 레이턴시: ${ttft}ms`);
                    console.log(`총 소요 시간: ${elapsed}ms`);
                    console.log('\n최종 응답:');
                    console.log(`"${fullResponse}"`);
                    console.log('='.repeat(60));
                },
                onError: (error) => console.error('스트림 에러:', error),
            },
            history
        );
    } catch (error) {
        console.error('LLM 요청 실패:', error);
        process.exit(1);
    }
}

main();
