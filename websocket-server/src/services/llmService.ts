import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
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
}
