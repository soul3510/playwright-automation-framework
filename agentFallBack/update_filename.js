const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '2_test_generator.mjs');
let content = fs.readFileSync(file, 'utf8');

// Replace the entire deriveTestFileName function
const oldFunc = /function deriveTestFileName\([^)]+\)\s*\{[\s\S]*?return candidate\.replace\(\/_\+\$\/,''\);\s*\}/;

const newFunc = `function deriveTestFileName({ pageTitle: t, scenarios: sc, pageId: pid, md }) {
    // 1. Get the first scenario row
    const firstScenario = Array.isArray(sc) && sc.length > 0 ? sc[0] : null;
    const firstRow = firstScenario?.row || firstScenario;
    
    // 2. INTELLIGENT FILENAME GENERATION: Analyze scenario to create meaningful name
    const subject = normalizeText(firstRow?.Subject);
    const details = normalizeText(firstRow?.Details);
    const additional = normalizeText(firstRow?.Additional);
    const fullText = (subject + ' ' + details + ' ' + additional).toLowerCase();
    
    // Extract key components using patterns
    const actionVerbs = ['verify', 'create', 'delete', 'update', 'edit', 'add', 'remove', 'check', 'validate', 'test'];
    const entities = ['brand', 'client', 'user', 'report', 'application', 'campaign', 'placement', 'metric', 'group', 'setting'];
    
    // Find action verb
    let action = '';
    for (const verb of actionVerbs) {
        if (fullText.includes(verb)) {
            action = verb;
            break;
        }
    }
    
    // Find primary entity
    let entity = '';
    for (const ent of entities) {
        if (fullText.includes(ent)) {
            entity = ent;
            break;
        }
    }
    
    // Extract key condition/qualifier
    const conditions = [
        { pattern: /unique\\s+name/, name: 'unique' },
        { pattern: /different\\s+client/, name: 'diff_client' },
        { pattern: /same\\s+name/, name: 'same_name' },
        { pattern: /existing\\s+name/, name: 'existing' },
        { pattern: /active/, name: 'active' },
        { pattern: /inactive/, name: 'inactive' },
        { pattern: /advertiser/, name: 'advertiser' },
        { pattern: /crossix\\s+admin/, name: 'admin' },
        { pattern: /crossix\\s+analyst/, name: 'analyst' }
    ];
    
    let condition = '';
    for (const cond of conditions) {
        if (cond.pattern.test(fullText)) {
            condition = cond.name;
            break;
        }
    }
    
    // Build intelligent filename
    let parts = [];
    if (action) parts.push(action);
    if (entity) parts.push(entity);
    if (condition) parts.push(condition);
    
    // If we couldn't extract smart components, fall back to cleaned subject
    let candidate = '';
    if (parts.length >= 2) {
        candidate = parts.join('_');
    } else if (subject && subject.length > 3) {
        // Fallback: use subject but remove filler words
        candidate = slugify(subject)
            .replace(/_verify_crossix_admin_can|_crossix_admin_can|_user_can/g, '')
            .replace(/_with_a|_for_an|_that_is/g, '_')
            .replace(/_the|_a|_an|_and|_or|_with|_for|_to|_from|_in|_on|_at/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    } else {
        candidate = slugify(t || 'manual_' + pid);
    }

    // 3. FINAL GUARDRAIL: Ensure filename doesn't exceed 80 characters
    if (candidate.length > 80) {
        candidate = candidate.substring(0, 80);
    }

    return candidate.replace(/_+$/, '');
}`;

if (oldFunc.test(content)) {
    content = content.replace(oldFunc, newFunc);
    fs.writeFileSync(file, content);
    console.log('✅ Updated deriveTestFileName with intelligent analysis');
} else {
    console.log('❌ Could not find function to replace');
    console.log('Trying partial match...');
    // Try to just replace the truncation part
    content = content.replace('if (candidate.length > 60) {', 'if (candidate.length > 80) {');
    content = content.replace('candidate = candidate.substring(0, 60);', 'candidate = candidate.substring(0, 80);');
    fs.writeFileSync(file, content);
    console.log('✅ Updated truncation limit to 80 chars');
}
