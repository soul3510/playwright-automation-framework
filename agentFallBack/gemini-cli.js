#!/usr/bin/env node

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('node:fs');
const path = require('node:path');

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

async function main() {
    loadDotEnv(path.join(__dirname, '.env'));

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    
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

    try {
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

        const result = await model.generateContent(input);
        const response = result.response.text();
        
        console.log(response);
        
    } catch (error) {
        console.error(`Error calling Gemini model "${modelName}":`, error.message);
        process.exit(1);
    }
}

main();
