import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface StreamCallbacks {
    onFirstToken?: () => void;
    onSentence: (sentence: string) => Promise<void>;
    onComplete?: (fullResponse: string) => void;
    onError?: (error: Error) => void;
}

export class LLMService {
    private model: ChatOpenAI;

    constructor(apiKey: string, modelName: string = "gpt-4o-mini", temperature: number = 0.7) {
        this.model = new ChatOpenAI({
            openAIApiKey: apiKey,
            modelName: modelName,
            temperature: temperature,
        });
    }

    /**
     * 대화 기록과 현재 사용자 메시지를 기반으로 LLM 응답을 생성
     * @param systemPrompt 컨텍스트를 설정하기 위한 시스템 프롬프트
     * @param userMessage 현재 사용자 메시지
     * @param history 선택적 대화 기록
     * @returns AI의 응답 텍스트
     */
    async generateResponse(
        systemPrompt: string,
        userMessage: string,
        history: ChatMessage[] = []
    ): Promise<string> {
        const messages: BaseMessage[] = [];

        // 시스템 프롬프트 추가
        messages.push(new SystemMessage(systemPrompt));

        // 대화 기록 추가
        for (const msg of history) {
            if (msg.role === 'user') {
                messages.push(new HumanMessage(msg.content));
            } else if (msg.role === 'assistant') {
                messages.push(new AIMessage(msg.content));
            } else if (msg.role === 'system') {
                messages.push(new SystemMessage(msg.content));
            }
        }

        // 현재 사용자 메시지 추가
        messages.push(new HumanMessage(userMessage));

        try {
            const response = await this.model.invoke(messages);

            if (typeof response.content === 'string') {
                return response.content;
            } else {
                // 필요한 경우 복합 콘텐츠 유형 처리, 현재는 결합
                return Array.isArray(response.content)
                    ? response.content.map(c => (typeof c === 'string' ? c : JSON.stringify(c))).join(' ')
                    : JSON.stringify(response.content);
            }
        } catch (error) {
            console.error("LLM 응답 생성 중 오류 발생:", error);
            throw error;
        }
    }

    /**
     * 초기 인사말 생성 (시스템 프롬프트 기반, 사용자 입력 없이)
     * 통화 시작 시 AI가 먼저 말을 걸도록 하는 용도
     * @param systemPrompt 시스템 프롬프트 (역할 및 지시사항)
     * @returns AI의 초기 인사말
     */
    async generateInitialGreeting(systemPrompt: string): Promise<string> {
        const messages: BaseMessage[] = [
            new SystemMessage(systemPrompt),
            new HumanMessage(''), // 빈 메시지로 응답 촉발
        ];

        try {
            const response = await this.model.invoke(messages);

            if (typeof response.content === 'string') {
                return response.content;
            } else {
                return Array.isArray(response.content)
                    ? response.content.map(c => (typeof c === 'string' ? c : JSON.stringify(c))).join(' ')
                    : JSON.stringify(response.content);
            }
        } catch (error) {
            console.error("초기 인사말 생성 중 오류 발생:", error);
            throw error;
        }
    }

    /**
     * 스트리밍 방식으로 LLM 응답을 생성하고 문장 단위로 콜백 호출
     * @param systemPrompt 컨텍스트를 설정하기 위한 시스템 프롬프트
     * @param userMessage 현재 사용자 메시지
     * @param callbacks 문장 완성 시 호출될 콜백들
     * @param history 선택적 대화 기록
     */
    async streamResponse(
        systemPrompt: string,
        userMessage: string,
        callbacks: StreamCallbacks,
        history: ChatMessage[] = []
    ): Promise<void> {
        const messages: BaseMessage[] = [];

        // 시스템 프롬프트 및 대화 기록추가
        messages.push(new SystemMessage(systemPrompt));

        for (const msg of history) {
            if (msg.role === 'user') {
                messages.push(new HumanMessage(msg.content));
            } else if (msg.role === 'assistant') {
                messages.push(new AIMessage(msg.content));
            } else if (msg.role === 'system') {
                messages.push(new SystemMessage(msg.content));
            }
        }

        // 현재 사용자 메시지 추가
        messages.push(new HumanMessage(userMessage));

        let buffer = '';
        let fullResponse = '';
        let isFirstToken = true;
        // 문장 종료를 판단하는 부호 패턴
        const sentenceEndingPattern = /[.!?\n]/;

        try {
            const stream = await this.model.stream(messages);

            for await (const chunk of stream) {
                const content = typeof chunk.content === 'string'
                    ? chunk.content
                    : '';

                if (!content) continue;

                if (isFirstToken) {
                    isFirstToken = false;
                    if (callbacks.onFirstToken) {
                        callbacks.onFirstToken();
                    }
                }

                buffer += content;
                fullResponse += content;

                // 버퍼에서 마지막 문장 종료 위치 탐색
                let lastSentenceEnd = -1;
                for (let i = 0; i < buffer.length; i++) {
                    if (sentenceEndingPattern.test(buffer[i])) {
                        // 종료 부호 뒤에 공백이 있거나 마지막 문자인 경우 문장 완성으로 간주
                        if (i === buffer.length - 1 || buffer[i + 1] === ' ' || buffer[i] === '\n') {
                            lastSentenceEnd = i;
                        }
                    }
                }

                // 완성된 문장을 콜백으로 전달
                if (lastSentenceEnd >= 0) {
                    const completedText = buffer.substring(0, lastSentenceEnd + 1).trim();
                    if (completedText) {
                        await callbacks.onSentence(completedText);
                    }
                    // 미완성 문장은 버퍼에 유지
                    buffer = buffer.substring(lastSentenceEnd + 1).trim();
                }
            }

            // 스트림 종료 후 남은 버퍼 처리
            if (buffer.trim()) {
                await callbacks.onSentence(buffer.trim());
            }

            if (callbacks.onComplete) {
                callbacks.onComplete(fullResponse.trim());
            }

        } catch (error) {
            console.error("LLM 스트리밍 응답 생성 중 오류 발생:", error);
            if (callbacks.onError) {
                callbacks.onError(error as Error);
            }
            throw error;
        }
    }
}
