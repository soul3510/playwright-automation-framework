// agentFallBack/clarification_manager.mjs
// Manages interactive clarification questions during test generation
import fs from "node:fs";
import path from "node:path";
import readline from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {spawn} from 'node:child_process';

const agentDir = process.cwd();
const clarificationPath = path.join(agentDir, "generated", "clarification_state.json");

/**
 * Play a system beep sound to notify user attention is needed
 */
function playNotificationSound() {
    try {
        // Windows PowerShell beep - works on Windows
        if (process.platform === 'win32') {
            spawn('powershell.exe', [
                '-c',
                '[System.Media.SystemSounds]::Exclamation.Play()'
            ], { stdio: 'ignore', detached: true }).unref();
        } else {
            // Unix/Mac - use terminal bell
            process.stdout.write('\x07');
        }
    } catch (e) {
        // Fallback to terminal bell if PowerShell fails
        process.stdout.write('\x07');
    }
}

/**
 * Checks if there are pending clarifications that need user input
 */
export function hasPendingClarifications() {
    if (!fs.existsSync(clarificationPath)) return false;
    try {
        const state = JSON.parse(fs.readFileSync(clarificationPath, "utf8"));
        return state.pending && state.pending.length > 0 && !state.resolved;
    } catch (e) {
        return false;
    }
}

/**
 * Loads pending clarifications
 */
export function loadPendingClarifications() {
    if (!fs.existsSync(clarificationPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(clarificationPath, "utf8"));
    } catch (e) {
        return null;
    }
}

/**
 * Saves a clarification request (called by agents when they detect a gap)
 */
export function requestClarification(context) {
    const state = loadPendingClarifications() || {
        pending: [],
        resolved: false,
        createdAt: new Date().toISOString(),
        pageId: context.pageId || "unknown"
    };

    state.pending.push({
        id: `clarification_${Date.now()}`,
        type: context.type,
        question: context.question,
        detectedAt: context.file || "unknown",
        detectedIn: context.method || "unknown",
        hint: context.hint || null,
        required: context.required || false,
        timestamp: new Date().toISOString()
    });

    fs.mkdirSync(path.dirname(clarificationPath), { recursive: true });
    fs.writeFileSync(clarificationPath, JSON.stringify(state, null, 2), "utf8");

    // Play notification sound immediately when clarification is requested
    playNotificationSound();

    console.log(`\n❓ Clarification requested: ${context.type}`);
    console.log(`   ${context.question}`);
    if (context.hint) console.log(`   Hint: ${context.hint}`);
    console.log(`   🔔 You will be asked to answer this when the agent pauses.`);
}

/**
 * Resolves clarifications with user input
 */
export async function resolveClarifications() {
    const state = loadPendingClarifications();
    if (!state || state.pending.length === 0) return null;

    // Play sound notification to alert user
    playNotificationSound();

    const rl = readline.createInterface({ input, output });
    const answers = {};

    console.log("\n" + "=".repeat(60));
    console.log("🤖 AGENT NEEDS MORE INFORMATION TO CONTINUE");
    console.log("=".repeat(60));
    console.log("🔔 Sound notification played - check the terminal!");

    for (const clarification of state.pending) {
        console.log(`\n❓ ${clarification.type}: ${clarification.question}`);
        if (clarification.hint) {
            console.log(`   💡 Hint: ${clarification.hint}`);
        }
        console.log("   (Press Enter to skip if you're unsure)");

        const answer = await rl.question("> ");
        answers[clarification.id] = answer.trim();
    }

    rl.close();

    // Save answers and mark as resolved
    state.answers = answers;
    state.resolved = true;
    state.resolvedAt = new Date().toISOString();
    fs.writeFileSync(clarificationPath, JSON.stringify(state, null, 2), "utf8");

    console.log("\n✅ Clarifications saved. Resuming generation...");
    console.log("=".repeat(60) + "\n");

    return answers;
}

/**
 * Gets an answer for a specific clarification ID
 */
export function getAnswer(clarificationId) {
    const state = loadPendingClarifications();
    if (!state || !state.answers) return null;
    return state.answers[clarificationId];
}

/**
 * Clears all clarifications (call after successful generation)
 */
export function clearClarifications() {
    if (fs.existsSync(clarificationPath)) {
        fs.unlinkSync(clarificationPath);
    }
}

/**
 * Check if clarifications should block the pipeline
 */
export function shouldPauseForClarification() {
    return hasPendingClarifications();
}
