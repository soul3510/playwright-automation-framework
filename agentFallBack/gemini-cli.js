#!/usr/bin/env node

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('node:fs');
const path = require('node:path');

const generatedDir = path.join(__dirname, 'generated');
const aiStatusPath = path.join(generatedDir, 'ai_provider_status.jsonl');

function recordAiStatus(event) {
    try {
        fs.mkdirSync(generatedDir, { recursive: true });
        fs.appendFileSync(aiStatusPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            ...event
        }) + '\n', 'utf8');
    } catch {
        // Status logging must never break the agent.
    }
}

function loadDotEnv(filePath) {
    if (!fs.existsSync(filePath)) return;

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const separator = trimmed.indexOf('=');
        if (separator === -1) continue;

        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();
        value = value.replace(/^["']|["']$/g, '');

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

async function callOpenAiFallback(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.OPENAI_MODEL || 'gpt-5-nano';

    if (!apiKey) {
        recordAiStatus({
            provider: 'openai',
            model: modelName,
            status: 'skipped',
            reason: 'OPENAI_API_KEY is not configured'
        });
        throw new Error('OPENAI_API_KEY is not configured in agentFallBack/.env');
    }

    recordAiStatus({
        provider: 'openai',
        model: modelName,
        status: 'started',
        reason: 'gemini_quota_exhausted_fallback'
    });

    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: modelName,
            input: prompt,
            max_output_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 4096),
            reasoning: { effort: process.env.OPENAI_REASONING_EFFORT || 'minimal' }
        })
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = body?.error?.message || response.statusText || `HTTP ${response.status}`;
        recordAiStatus({
            provider: 'openai',
            model: modelName,
            status: 'failed',
            error: message
        });
        throw new Error(`OpenAI fallback failed for model "${modelName}": ${message}`);
    }

    const text = body.output_text ||
        (Array.isArray(body.output)
            ? body.output.flatMap(item => item.content || [])
                .map(content => content.text || "")
                .filter(Boolean)
                .join("\n")
            : "");

    if (!text.trim()) {
        recordAiStatus({
            provider: 'openai',
            model: modelName,
            status: 'failed',
            error: 'empty_response'
        });
        throw new Error(`OpenAI fallback returned an empty response for model "${modelName}"`);
    }

    recordAiStatus({
        provider: 'openai',
        model: modelName,
        status: 'success',
        reason: 'gemini_quota_exhausted_fallback'
    });
    console.error(`AI_PROVIDER_FALLBACK=OPENAI`);
    console.error(`OPENAI_FALLBACK_MODEL=${modelName}`);
    return text;
}

function friendlyGeminiError(error, modelName) {
    const message = String(error?.message || error || "");
    const lower = message.toLowerCase();

    if (
        lower.includes("429") ||
        lower.includes("quota") ||
        lower.includes("resource_exhausted") ||
        lower.includes("rate limit") ||
        lower.includes("rate_limit") ||
        lower.includes("too many requests")
    ) {
        return {
            code: "GEMINI_QUOTA_EXHAUSTED",
            message: [
                "Gemini API limit reached for this API key.",
                "The agent cannot use Gemini right now because the key has reached its quota/rate/token limit.",
                "Wait for the quota window to reset, switch to another key, or use a billing-enabled Gemini project/key.",
                `Model used: ${modelName}`
            ].join(" ")
        };
    }

    if (
        lower.includes("token") &&
        (lower.includes("maximum") || lower.includes("limit") || lower.includes("too large") || lower.includes("exceeds"))
    ) {
        return {
            code: "GEMINI_CONTEXT_TOO_LARGE",
            message: [
                "Gemini request is too large for the selected model.",
                "The agent collected more page/test context than the model can accept.",
                "Try generating fewer scenarios, using a smaller page, or switch to a model with a larger context window.",
                `Model used: ${modelName}`
            ].join(" ")
        };
    }

    if (lower.includes("404") && lower.includes("model")) {
        return {
            code: "GEMINI_MODEL_UNAVAILABLE",
            message: [
                `Gemini model "${modelName}" is unavailable for this API key or API version.`,
                "Update GEMINI_MODEL in agentFallBack/.env, for example GEMINI_MODEL=gemini-2.5-flash."
            ].join(" ")
        };
    }

    if (lower.includes("api key") || lower.includes("permission") || lower.includes("unauthorized") || lower.includes("403")) {
        return {
            code: "GEMINI_AUTH_ERROR",
            message: [
                "Gemini API key is missing, invalid, disabled, or not allowed to use this model.",
                "Check agentFallBack/.env and verify the key has access to the configured GEMINI_MODEL."
            ].join(" ")
        };
    }

    return {
        code: "GEMINI_UNKNOWN_ERROR",
        message: `Gemini request failed for model "${modelName}". ${message}`
    };
}

async function main() {
    loadDotEnv(path.join(__dirname, '.env'));

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    
    if (!apiKey) {
        console.error('Error: GEMINI_API_KEY or GOOGLE_AI_API_KEY environment variable is required');
        process.exit(1);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2)
        }
    });

    // Read input from stdin
    let input = '';
    process.stdin.setEncoding('utf8');
    
    for await (const chunk of process.stdin) {
        input += chunk;
    }

    if (!input.trim()) {
        console.error('Error: No input provided');
        process.exit(1);
    }

    try {
        recordAiStatus({
            provider: 'gemini',
            model: modelName,
            status: 'started'
        });
        const result = await model.generateContent(input);
        const response = result.response.text();
        recordAiStatus({
            provider: 'gemini',
            model: modelName,
            status: 'success'
        });
        
        console.log(response);
        
    } catch (error) {
        const friendly = friendlyGeminiError(error, modelName);
        recordAiStatus({
            provider: 'gemini',
            model: modelName,
            status: 'failed',
            errorCode: friendly.code,
            error: friendly.message
        });
        if (friendly.code === 'GEMINI_QUOTA_EXHAUSTED' && process.env.OPENAI_API_KEY) {
            console.error(`GEMINI_AGENT_ERROR_CODE=${friendly.code}`);
            console.error(`GEMINI_AGENT_ERROR_MESSAGE=${friendly.message}`);
            console.error('Gemini quota exhausted. Trying OpenAI fallback...');

            try {
                const fallbackResponse = await callOpenAiFallback(input);
                console.log(fallbackResponse);
                return;
            } catch (fallbackError) {
                console.error(`OPENAI_FALLBACK_ERROR=${fallbackError.message}`);
            }
        }
        console.error(`GEMINI_AGENT_ERROR_CODE=${friendly.code}`);
        console.error(`GEMINI_AGENT_ERROR_MESSAGE=${friendly.message}`);
        console.error(`Raw Gemini error: ${error.message}`);
        process.exit(1);
    }
}

main();
