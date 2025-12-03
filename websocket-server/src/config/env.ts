import dotenv from 'dotenv';
import logger from './logger';

dotenv.config();

export const PORT = parseInt(process.env.PORT || '8081', 10);
export const PUBLIC_URL = process.env.PUBLIC_URL || '';
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;

export const TWILIO_CALLER_NUMBERS = process.env.TWILIO_CALLER_NUMBERS?.split(',').map((num) => num.trim()) || [];

// RTZR STT API
export const RTZR_CLIENT_ID = process.env.RTZR_CLIENT_ID || '';
export const RTZR_CLIENT_SECRET = process.env.RTZR_CLIENT_SECRET || '';

if (TWILIO_CALLER_NUMBERS.length === 0) {
    logger.error('TWILIO_CALLER_NUMBERS environment variable is required (comma-separated)');
    process.exit(1);
}

if (!OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

if (!RTZR_CLIENT_ID || !RTZR_CLIENT_SECRET) {
    logger.error('RTZR_CLIENT_ID and RTZR_CLIENT_SECRET environment variables are required');
    process.exit(1);
}
