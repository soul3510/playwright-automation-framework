// agentFallBack/cleanup_generated.mjs
import fs from 'node:fs';
import path from 'node:path';

const agentDir = process.cwd();
const generatedDir = path.join(agentDir, 'generated');
const logsDir = path.join(agentDir, 'logs', 'failed_runs');

function getTimestamp() {
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${Y}-${M}-${D}_${h}${m}`;
}

function cleanup() {
    const isArchiveMode = process.argv.includes('--archive');
    
    // Extract descriptive name if provided after --name flag
    const nameIdx = process.argv.indexOf('--name');
    const descriptiveName = nameIdx !== -1 ? process.argv[nameIdx + 1] : "";
    
    console.log(isArchiveMode ? "📦 Archiving metadata from failed run..." : "🧹 Cleaning up generated files...");

    if (!fs.existsSync(generatedDir)) {
        console.log("📂 No generated folder found. Nothing to clean.");
        return;
    }

    const files = fs.readdirSync(generatedDir);
    if (files.length === 0) {
        console.log("✨ Folder is already empty.");
        return;
    }

    let archivePath = "";
    if (isArchiveMode) {
        let folderName = getTimestamp();
        if (descriptiveName) {
            folderName += `_${descriptiveName}`;
        }
        
        archivePath = path.join(logsDir, folderName);
        if (!fs.existsSync(archivePath)) {
            fs.mkdirSync(archivePath, { recursive: true });
        }
    }

    for (const file of files) {
        if (file === 'repo_knowledge.json' || file === 'ai_provider_status.jsonl' || file === 'ui_state.json') continue;

        const srcPath = path.join(generatedDir, file);
        const stats = fs.lstatSync(srcPath);

        try {
            if (isArchiveMode) {
                const destPath = path.join(archivePath, file);
                fs.renameSync(srcPath, destPath);
            } else {
                if (stats.isDirectory()) {
                    fs.rmSync(srcPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(srcPath);
                }
                console.log(`  🗑️ Deleted: ${file}`);
            }
        } catch (err) {
            console.error(`  ❌ Failed to process ${file}: ${err.message}`);
        }
    }

    if (isArchiveMode) {
        console.log(`✅ Archived failure metadata to: ${archivePath}`);
    } else {
        console.log("✅ Cleanup complete. Ready for a fresh start.");
    }
}

cleanup();
